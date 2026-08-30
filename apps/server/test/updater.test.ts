import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { config } from '../src/config.js'
import { OmpUpdater, OmpUpdateEvent, planSwap, releaseEligible, shouldRollback, normalizeRepoInput, normalizeReleaseSha256, validateReleaseVersion, pickReleaseAsset, findChecksumAsset, extractSha256FromSums, sha256FromAssetDigest, UpdateState } from '../src/omp/updater.js'

/** Mimics the undici v7 Agent that Electron's Node runtime (ELECTRON_RUN_AS_NODE)
 *  leaves on the global dispatcher symbol the bundled undici v6 reads. Passing
 *  `maxRedirections` through it fails with "maxRedirections is not supported,
 *  use the redirect interceptor", which is how every OMP download broke. */
class MaxRedirectionsRejectingAgent extends Agent {
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    const maxRedirections = (options as { maxRedirections?: number }).maxRedirections
    if (maxRedirections != null && maxRedirections !== 0) {
      throw new Error('maxRedirections is not supported, use the redirect interceptor')
    }
    return super.dispatch(options, handler)
  }
}

const base: UpdateState = {
  currentVersion: 'v17.2.1',
  previousVersion: null,
  channel: 'fast',
  lastCheckedAt: null,
  lastError: null,
  latestUpstream: null,
  repo: null
}

describe('normalizeRepoInput', () => {
  it('accepts a plain owner/repo', () => {
    expect(normalizeRepoInput('can1357/oh-my-pi')).toBe('can1357/oh-my-pi')
  })

  it('accepts an empty override so the built-in official repo can take over', () => {
    expect(normalizeRepoInput('  ')).toBe('')
  })

  it('converts full-width slashes from CJK IMEs', () => {
    expect(normalizeRepoInput('can1357／oh-my-pi')).toBe('can1357/oh-my-pi')
  })

  it('strips whitespace and zero-width characters', () => {
    const zw = String.fromCharCode(0x200b)
    expect(normalizeRepoInput(` can1357/${zw}oh-my-pi \n`)).toBe('can1357/oh-my-pi')
  })

  it('accepts pasted GitHub URLs and .git suffixes', () => {
    expect(normalizeRepoInput('https://github.com/can1357/oh-my-pi')).toBe('can1357/oh-my-pi')
    expect(normalizeRepoInput('https://github.com/can1357/oh-my-pi.git')).toBe('can1357/oh-my-pi')
    expect(normalizeRepoInput('can1357/oh-my-pi/')).toBe('can1357/oh-my-pi')
  })

  it('rejects non-official updater repositories', () => {
    expect(() => normalizeRepoInput('attacker/omp')).toThrow(/官方仓库/)
  })
})

describe('planSwap', () => {
  it('remembers the OLD current as previous (regression: rollback used to be a no-op)', () => {
    const next = planSwap(base, 'v17.3.0')
    expect(next.currentVersion).toBe('v17.3.0')
    expect(next.previousVersion).toBe('v17.2.1')
  })

  it('rollback via planSwap restores the old version', () => {
    const upgraded = planSwap(base, 'v17.3.0')
    const rolledBack = planSwap(upgraded, upgraded.previousVersion!)
    expect(rolledBack.currentVersion).toBe('v17.2.1')
    expect(rolledBack.previousVersion).toBe('v17.3.0')
  })

  it('does not mutate the input state', () => {
    planSwap(base, 'v17.3.0')
    expect(base.currentVersion).toBe('v17.2.1')
  })
})

describe('releaseEligible', () => {
  const now = 1_800_000_000_000
  it('fast channel waits ~15 minutes', () => {
    expect(releaseEligible(now - 5 * 60_000, 'fast', now)).toBe(false)
    expect(releaseEligible(now - 20 * 60_000, 'fast', now)).toBe(true)
  })
  it('stable channel waits ~24 hours', () => {
    expect(releaseEligible(now - 60 * 60_000, 'stable', now)).toBe(false)
    expect(releaseEligible(now - 25 * 60 * 60_000, 'stable', now)).toBe(true)
  })
  it('experimental is immediate', () => {
    expect(releaseEligible(now, 'experimental', now)).toBe(true)
  })
})

describe('shouldRollback', () => {
  it('rolls back at the failure threshold', () => {
    expect(shouldRollback(0)).toBe(false)
    expect(shouldRollback(2)).toBe(false)
    expect(shouldRollback(3)).toBe(true)
  })
})

describe('pickReleaseAsset', () => {
  it('picks the platform+arch binary', () => {
    const assets = [
      { name: 'omp-darwin-arm64' },
      { name: 'omp-windows-x64.exe' },
      { name: 'omp-linux-amd64' }
    ]
    expect(pickReleaseAsset(assets, 'win32', 'x64')?.name).toBe('omp-windows-x64.exe')
    expect(pickReleaseAsset(assets, 'darwin', 'arm64')?.name).toBe('omp-darwin-arm64')
    expect(pickReleaseAsset(assets, 'linux', 'x64')?.name).toBe('omp-linux-amd64')
  })

  it('matches bare win naming without matching darwin', () => {
    const assets = [{ name: 'omp-darwin-x64' }, { name: 'omp-win-x64.exe' }]
    expect(pickReleaseAsset(assets, 'win32', 'x64')?.name).toBe('omp-win-x64.exe')
  })

  it('never falls back to checksum or signature files', () => {
    const assets = [{ name: 'checksums.txt' }, { name: 'omp.sig' }, { name: 'omp-solaris' }]
    expect(pickReleaseAsset(assets, 'win32', 'x64')?.name).toBe('omp-solaris')
    expect(pickReleaseAsset([{ name: 'checksums.txt' }], 'win32', 'x64')).toBeNull()
  })

  it('falls back to platform-only match when arch is absent from names', () => {
    const assets = [{ name: 'omp-windows.exe' }, { name: 'omp-linux' }]
    expect(pickReleaseAsset(assets, 'win32', 'x64')?.name).toBe('omp-windows.exe')
  })

  it('prefers the musl asset on Alpine and the gnu asset on glibc', () => {
    const assets = [
      { name: 'omp-linux-aarch64-gnu' },
      { name: 'omp-linux-aarch64-musl' },
      { name: 'omp-linux-x86_64-gnu' },
      { name: 'omp-linux-x86_64-musl' }
    ]
    expect(pickReleaseAsset(assets, 'linux', 'arm64', 'musl')?.name).toBe('omp-linux-aarch64-musl')
    expect(pickReleaseAsset(assets, 'linux', 'arm64', 'glibc')?.name).toBe('omp-linux-aarch64-gnu')
    expect(pickReleaseAsset(assets, 'linux', 'x64', 'musl')?.name).toBe('omp-linux-x86_64-musl')
  })

  it('takes the untagged linux build when the release has no musl asset', () => {
    const assets = [{ name: 'omp-linux-aarch64' }, { name: 'omp-linux-aarch64-gnu' }]
    expect(pickReleaseAsset(assets, 'linux', 'arm64', 'musl')?.name).toBe('omp-linux-aarch64')
  })

  it('ignores libc naming outside Linux', () => {
    const assets = [{ name: 'omp-darwin-arm64' }]
    expect(pickReleaseAsset(assets, 'darwin', 'arm64', 'musl')?.name).toBe('omp-darwin-arm64')
  })
})

describe('findChecksumAsset', () => {
  it('prefers the per-asset digest over a combined list', () => {
    const assets = [{ name: 'SHASUMS256.txt' }, { name: 'omp-windows-x64.exe.sha256' }]
    expect(findChecksumAsset(assets, 'omp-windows-x64.exe')?.name).toBe('omp-windows-x64.exe.sha256')
  })

  it('recognizes SHASUMS256.txt, which the old regex missed', () => {
    expect(findChecksumAsset([{ name: 'SHASUMS256.txt' }], 'omp.exe')?.name).toBe('SHASUMS256.txt')
  })

  it('returns null when nothing checksum-like exists', () => {
    expect(findChecksumAsset([{ name: 'omp.exe' }], 'omp.exe')).toBeNull()
  })
})

describe('extractSha256FromSums', () => {
  const HEX = 'ab'.repeat(32)

  it('parses "hash  name" lines', () => {
    expect(extractSha256FromSums(`${HEX}  omp-windows-x64.exe\n${'cd'.repeat(32)}  omp-linux`, 'omp-windows-x64.exe')).toBe(HEX)
  })

  it('parses "hash *name" binary-mode lines', () => {
    expect(extractSha256FromSums(`${HEX} *omp-windows-x64.exe`, 'omp-windows-x64.exe')).toBe(HEX)
  })

  it('parses "name: hash" style lines and normalizes case', () => {
    expect(extractSha256FromSums(`omp-windows-x64.exe: ${HEX.toUpperCase()}`, 'omp-windows-x64.exe')).toBe(HEX)
  })

  it('accepts a bare hash only for per-asset digest files', () => {
    expect(extractSha256FromSums(HEX, 'omp-windows-x64.exe', true)).toBe(HEX)
    expect(extractSha256FromSums(HEX, 'omp-windows-x64.exe', false)).toBeUndefined()
  })

  it('refuses a combined list that lacks the target asset', () => {
    expect(extractSha256FromSums(`${HEX}  omp-linux-amd64`, 'omp-windows-x64.exe')).toBeUndefined()
  })
})

describe('sha256FromAssetDigest', () => {
  it('extracts and lowercases the hex from a GitHub asset digest', () => {
    expect(sha256FromAssetDigest(`sha256:${'AB'.repeat(32)}`)).toBe('ab'.repeat(32))
  })

  it('rejects missing, malformed, or non-sha256 digests', () => {
    expect(sha256FromAssetDigest(undefined)).toBeUndefined()
    expect(sha256FromAssetDigest(null)).toBeUndefined()
    expect(sha256FromAssetDigest('sha512:' + 'ab'.repeat(64))).toBeUndefined()
    expect(sha256FromAssetDigest('ab'.repeat(32))).toBeUndefined()
  })
})

describe('release artifact validation', () => {
  it('rejects traversal in release tags', () => {
    expect(() => validateReleaseVersion('../../escape')).toThrow(/版本标签/)
    expect(validateReleaseVersion('v17.3.4')).toBe('v17.3.4')
  })

  it('requires a complete SHA256 digest', () => {
    expect(() => normalizeReleaseSha256(undefined)).toThrow(/SHA256/)
    expect(normalizeReleaseSha256('A'.repeat(64))).toBe('a'.repeat(64))
  })
})

describe('OmpUpdater events', () => {
  let tempDir: string
  let originalOmpDir: string

  beforeEach(async () => {
    originalOmpDir = config.ompDir
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botcf-updater-'))
    config.ompDir = tempDir
  })

  afterEach(async () => {
    config.ompDir = originalOmpDir
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  async function createUpdater(healthy = true, idle = true) {
    let idleCallback: (() => void) | undefined
    const updater = new OmpUpdater({
      isIdle: () => idle,
      onIdleOnce: (callback) => { idleCallback = callback },
      healthProbe: vi.fn(async () => healthy),
      log: vi.fn()
    })
    await updater.init()
    const currentDir = path.join(tempDir, 'versions', 'v1')
    await fs.mkdir(currentDir, { recursive: true })
    await fs.writeFile(path.join(currentDir, process.platform === 'win32' ? 'omp.exe' : 'omp'), 'old')
    await updater.swapTo('v1')
    return { updater, setIdle: (value: boolean) => { idle = value }, fireIdle: () => idleCallback?.() }
  }

  async function stageRelease(updater: OmpUpdater) {
    const binary = Buffer.from('new binary')
    const version = 'v2'
    const dir = path.join(tempDir, 'versions', version)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, process.platform === 'win32' ? 'omp.exe' : 'omp'), binary)
    vi.spyOn(updater, 'fetchLatestRelease').mockResolvedValue({
      version,
      publishedAt: 0,
      assetUrl: 'https://invalid.test/omp',
      sha256: crypto.createHash('sha256').update(binary).digest('hex')
    })
  }

  it('emits found, verifying, and switched for an already downloaded release', async () => {
    const { updater } = await createUpdater()
    await stageRelease(updater)
    const events: OmpUpdateEvent[] = []
    updater.on('update', (event) => events.push(event))
    await updater.checkOnce()
    expect(events.map((event) => event.phase)).toEqual(['found', 'verifying', 'switched'])
    expect(events.at(-1)?.state.currentVersion).toBe('v2')
  })

  it('emits rolled-back with the restored state after health failure', async () => {
    const { updater } = await createUpdater(false)
    await stageRelease(updater)
    const events: OmpUpdateEvent[] = []
    updater.on('update', (event) => events.push(event))
    await updater.checkOnce()
    expect(events.map((event) => event.phase)).toEqual(['found', 'verifying', 'rolled-back'])
    expect(events.at(-1)?.state.currentVersion).toBe('v1')
  })

  it('retries the pending release immediately when generation becomes idle', async () => {
    const { updater, setIdle, fireIdle } = await createUpdater(true, false)
    await stageRelease(updater)
    const phases: string[] = []
    updater.on('update', (event: OmpUpdateEvent) => phases.push(event.phase))
    await updater.checkOnce()
    expect(phases).toEqual(['found', 'waiting-idle'])
    setIdle(true)
    fireIdle()
    await vi.waitFor(() => expect(updater.getState().currentVersion).toBe('v2'))
    expect(phases).toEqual(['found', 'waiting-idle', 'found', 'verifying', 'switched'])
    expect(updater.fetchLatestRelease).toHaveBeenCalledTimes(1)
  })

  it('uses the official repo automatically on a fresh installation', async () => {
    const updater = new OmpUpdater({
      isIdle: () => true,
      onIdleOnce: vi.fn(),
      healthProbe: vi.fn(async () => true),
      log: vi.fn()
    })
    await updater.init()
    expect(updater.effectiveRepo()).toBe('can1357/oh-my-pi')
    expect(updater.getState().repo).toBe('can1357/oh-my-pi')
  })

  it('checks immediately when the automatic update loop starts', async () => {
    const updater = new OmpUpdater({
      isIdle: () => true,
      onIdleOnce: vi.fn(),
      healthProbe: vi.fn(async () => true),
      log: vi.fn()
    })
    await updater.init()
    const fetchSpy = vi.spyOn(updater, 'fetchLatestRelease').mockResolvedValue(null)

    updater.startLoop()
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    updater.stopLoop()
  })

  it('does not delay the first OMP installation for the fast channel', async () => {
    const updater = new OmpUpdater({
      isIdle: () => true,
      onIdleOnce: vi.fn(),
      healthProbe: vi.fn(async () => true),
      log: vi.fn()
    })
    await updater.init()
    const binary = Buffer.from('first install')
    const version = 'v-first'
    vi.spyOn(updater, 'fetchLatestRelease').mockResolvedValue({
      version,
      publishedAt: Date.now(),
      assetUrl: 'https://invalid.test/omp',
      sha256: crypto.createHash('sha256').update(binary).digest('hex')
    })
    const targetDir = path.join(config.ompDir, 'versions', version)
    await fs.mkdir(targetDir, { recursive: true })
    await fs.writeFile(path.join(targetDir, process.platform === 'win32' ? 'omp.exe' : 'omp'), binary)

    await updater.checkOnce()
    expect(updater.getState().currentVersion).toBe(version)
  })

  it('coalesces concurrent startup and manual checks into one release request', async () => {
    const { updater } = await createUpdater()
    let resolveRelease!: (release: Awaited<ReturnType<OmpUpdater['fetchLatestRelease']>>) => void
    const releasePromise = new Promise<Awaited<ReturnType<OmpUpdater['fetchLatestRelease']>>>((resolve) => {
      resolveRelease = resolve
    })
    const fetchSpy = vi.spyOn(updater, 'fetchLatestRelease').mockReturnValue(releasePromise)

    const startupCheck = updater.checkOnce()
    const manualCheck = updater.checkOnce()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    resolveRelease({ version: 'v1', publishedAt: 0, assetUrl: 'https://invalid.test/omp' })
    await Promise.all([startupCheck, manualCheck])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('records a release-network failure without rejecting or stopping the service', async () => {
    const { updater } = await createUpdater()
    vi.spyOn(updater, 'fetchLatestRelease').mockRejectedValue(new Error('fetch failed'))

    await expect(updater.checkOnce()).resolves.toBeUndefined()
    expect(updater.getState().lastError).toBe('fetch failed')
  })

  it('downloads through redirects on a dispatcher that rejects maxRedirections', async () => {
    const binary = Buffer.from('redirected omp binary')
    const paths: string[] = []
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? '')
      if (req.url === '/download/omp') {
        res.writeHead(302, { location: '/objects/signed/omp' })
        res.end()
        return
      }
      if (req.url === '/objects/signed/omp') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(binary)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const previousDispatcher = getGlobalDispatcher()
    const strictAgent = new MaxRedirectionsRejectingAgent()
    setGlobalDispatcher(strictAgent)

    try {
      const { updater } = await createUpdater()
      const events: OmpUpdateEvent[] = []
      updater.on('update', (event: OmpUpdateEvent) => events.push(event))

      await updater.installAndSwap({
        version: 'v3',
        publishedAt: 0,
        assetUrl: `http://127.0.0.1:${port}/download/omp`,
        sha256: crypto.createHash('sha256').update(binary).digest('hex')
      })

      expect(events.map((event) => event.phase)).toEqual(['downloading', 'verifying', 'switched'])
      expect(paths).toEqual(['/download/omp', '/objects/signed/omp'])
      const binName = process.platform === 'win32' ? 'omp.exe' : 'omp'
      expect(await fs.readFile(path.join(tempDir, 'versions', 'v3', binName))).toEqual(binary)
    } finally {
      setGlobalDispatcher(previousDispatcher)
      await strictAgent.close()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  })
})

describe('OmpUpdater.rollbackVerified', () => {
  let tempDir: string
  let originalOmpDir: string

  beforeEach(async () => {
    originalOmpDir = config.ompDir
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botcf-rollback-'))
    config.ompDir = tempDir
  })

  afterEach(async () => {
    config.ompDir = originalOmpDir
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  /** current=v2, previous=v1 — the state a user rolls back from. */
  async function twoVersions(healthProbe: () => Promise<boolean>, isIdle = () => true) {
    const updater = new OmpUpdater({ isIdle, onIdleOnce: vi.fn(), healthProbe, log: vi.fn() })
    await updater.init()
    for (const version of ['v1', 'v2']) {
      const dir = path.join(tempDir, 'versions', version)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, process.platform === 'win32' ? 'omp.exe' : 'omp'), version)
      await updater.swapTo(version)
    }
    return updater
  }

  it('verifies the rolled-back version with the same health probe as an update', async () => {
    const probe = vi.fn(async () => true)
    const updater = await twoVersions(probe)

    await expect(updater.rollbackVerified()).resolves.toEqual({ ok: true })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(updater.getState().currentVersion).toBe('v1')
    expect(updater.getState().previousVersion).toBe('v2')
    expect(updater.getState().lastError).toBeNull()
  })

  it('swaps back to the running version when the rolled-back one fails to verify', async () => {
    const probe = vi.fn(async () => probe.mock.calls.length > 1)
    const updater = await twoVersions(probe)

    const result = await updater.rollbackVerified()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('已切回 v2')
    expect(updater.getState().currentVersion).toBe('v2')
    expect(updater.getState().previousVersion).toBe('v1')
  })

  it('reports the failed restore instead of claiming the rollback worked', async () => {
    const updater = await twoVersions(async () => false)

    const result = await updater.rollbackVerified()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('切回 v2 后验证同样失败')
    expect(updater.getState().lastError).toBe(result.error)
  })

  it('refuses to swap binaries while a generation is in flight', async () => {
    const probe = vi.fn(async () => true)
    const updater = await twoVersions(probe, () => false)

    const result = await updater.rollbackVerified()
    expect(result.ok).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    expect(updater.getState().currentVersion).toBe('v2')
  })

  it('reports that there is nothing to roll back to', async () => {
    const updater = new OmpUpdater({
      isIdle: () => true,
      onIdleOnce: vi.fn(),
      healthProbe: vi.fn(async () => true),
      log: vi.fn()
    })
    await updater.init()

    await expect(updater.rollbackVerified()).resolves.toEqual({ ok: false, error: '无可回滚版本' })
  })
})
