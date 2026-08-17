import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../src/config.js'
import { OmpUpdater, OmpUpdateEvent, planSwap, releaseEligible, shouldRollback, normalizeRepoInput, normalizeReleaseSha256, validateReleaseVersion, UpdateState } from '../src/omp/updater.js'

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
})
