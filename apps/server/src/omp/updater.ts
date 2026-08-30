import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { EventEmitter } from 'node:events'
import { requestFollowingRedirects } from '../httpRedirect.js'
import { config, DEFAULT_OMP_GITHUB_REPO } from '../config.js'

export type OmpUpdatePhase = 'found' | 'waiting-delay' | 'waiting-idle' | 'downloading' | 'verifying' | 'switched' | 'rolled-back' | 'error'

export interface OmpUpdateEvent {
  phase: OmpUpdatePhase
  version: string | null
  error?: string
  state: UpdateState
}

export interface UpdateState {
  currentVersion: string | null
  previousVersion: string | null
  channel: 'fast' | 'stable' | 'experimental'
  lastCheckedAt: number | null
  lastError: string | null
  latestUpstream: string | null
  /** GitHub repo (owner/repo) for OMP releases; UI-configurable, overrides env. */
  repo: string | null
}

export interface ReleaseInfo {
  version: string
  publishedAt: number
  assetUrl: string
  sha256?: string
}

export function validateReleaseVersion(version: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version) || version === '..') {
    throw new Error(`无效 OMP 版本标签: ${version}`)
  }
  return version
}

export function normalizeReleaseSha256(value: string | undefined): string {
  const digest = value?.trim().toLowerCase() ?? ''
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('OMP Release 未提供有效 SHA256')
  return digest
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export const OFFICIAL_OMP_REPO = DEFAULT_OMP_GITHUB_REPO

/** Pure: normalize a user-pasted repo string — full-width slashes from CJK IMEs,
 *  zero-width characters, full GitHub URLs, and .git suffixes are all accepted. */
export function normalizeRepoInput(input: string): string {
  // U+200B..U+200D and U+FEFF, built from char codes so no invisible
  // characters live in this source file.
  const zeroWidth = new RegExp('[' + String.fromCharCode(0x200b, 0x200c, 0x200d, 0xfeff) + ']', 'g')
  const repo = input
    .replace(/／/g, '/')
    .replace(/\s+/g, '')
    .replace(zeroWidth, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  if (!repo) return ''
  if (repo !== OFFICIAL_OMP_REPO) throw new Error(`OMP 更新仅允许官方仓库 ${OFFICIAL_OMP_REPO}`)
  return repo
}

/** Pure: swapping to a new version must remember the OLD current as previous —
 *  the original implementation set previous to the new version, making rollback
 *  a no-op. Unit-tested. */
export function planSwap(state: UpdateState, newVersion: string): UpdateState {
  return {
    ...state,
    previousVersion: state.currentVersion,
    currentVersion: newVersion
  }
}

/** Pure: a release is only eligible once its channel delay has elapsed. */
export function releaseEligible(publishedAt: number, channel: UpdateState['channel'], now: number): boolean {
  const delayMs = (config.ompUpdate.channelDelayMinutes[channel] ?? 15) * 60_000
  return now - publishedAt >= delayMs
}

/** Pure: pick the platform/arch binary asset. Checksum/signature/text files are
 *  never candidates — the old `?? assets[0]` fallback could select checksums.txt.
 *
 *  `libc` matters on Linux only, and only because the failure is silent until
 *  runtime: a glibc-linked aarch64 binary downloads and chmods fine on Alpine
 *  and then dies with `Could not open /lib/ld-linux-aarch64.so.1`. When the host
 *  is musl and the release ships a musl asset, that asset wins; a glibc-named
 *  asset is only used when nothing else matches. */
export function pickReleaseAsset<T extends { name: string }>(
  assets: T[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  libc: 'glibc' | 'musl' = detectLibc()
): T | null {
  const candidates = assets.filter((a) => !/\.(txt|sha256(sum)?|sig|asc|json|md|pem|sbom)$/i.test(a.name))
  // \bwin\b avoids matching the "win" inside "darwin".
  const platformRe = platform === 'win32'
    ? /windows|\bwin\d*\b/i
    : platform === 'darwin'
      ? /darwin|mac(os)?|osx/i
      : /linux/i
  const archRe = arch === 'arm64' ? /arm64|aarch64/i : /x64|amd64|x86[_-]?64/i
  const musl = /musl|alpine/i
  const glibc = /gnu|glibc/i
  const matchesLibc = (name: string): boolean =>
    platform !== 'linux' || (libc === 'musl' ? musl.test(name) : !musl.test(name))
  const platformArch = candidates.filter((a) => platformRe.test(a.name) && archRe.test(a.name))
  const platformOnly = candidates.filter((a) => platformRe.test(a.name))
  return platformArch.find((a) => matchesLibc(a.name))
    // A release with no libc-tagged asset at all: the single linux build is
    // usually static, so prefer it over a wrong-arch or wrong-libc pick.
    ?? platformArch.find((a) => platform !== 'linux' || (!musl.test(a.name) && !glibc.test(a.name)))
    ?? platformArch[0]
    ?? platformOnly.find((a) => matchesLibc(a.name))
    ?? platformOnly[0]
    ?? candidates[0]
    ?? null
}

/** Which C library the current process is linked against. Node reports the
 *  runtime glibc version only when it has one, so its absence on Linux means
 *  musl (Alpine). */
export function detectLibc(): 'glibc' | 'musl' {
  if (process.platform !== 'linux') return 'glibc'
  try {
    const header = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    return header?.header?.glibcVersionRuntime ? 'glibc' : 'musl'
  } catch {
    return 'glibc'
  }
}

/** Pure: choose the checksum-bearing asset for a binary asset. A per-asset
 *  digest file (<name>.sha256) wins over combined checksum lists so we never
 *  read another platform's digest. */
export function findChecksumAsset<T extends { name: string }>(assets: T[], assetName: string): T | null {
  const lower = assetName.toLowerCase()
  return assets.find((a) => {
    const n = a.name.toLowerCase()
    return n === `${lower}.sha256` || n === `${lower}.sha256sum` || n === `${lower}.digest`
  })
    ?? assets.find((a) => /check-?sums?|sha-?256|shasums/i.test(a.name))
    ?? null
}

/** Pure: GitHub attaches a "sha256:<hex>" digest to each release asset;
 *  prefer it — it exists even when the repo publishes no checksum files. */
export function sha256FromAssetDigest(digest: string | null | undefined): string | undefined {
  const m = /^sha256:([a-f0-9]{64})$/i.exec(digest ?? '')
  return m ? m[1].toLowerCase() : undefined
}

/** Pure: extract the 64-hex digest for assetName from a checksum file body.
 *  Handles "hash  name", "hash *name", "name: hash", and — only for per-asset
 *  digest files — a bare hash with no filename. */
export function extractSha256FromSums(text: string, assetName: string, perAssetFile = false): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const hexToken = (line: string): string | undefined =>
    line.split(/\s+/).map((token) => token.replace(/^\*/, '')).find((token) => /^[a-f0-9]{64}$/i.test(token))
  const named = lines.find((line) => line.toLowerCase().includes(assetName.toLowerCase()))
  if (named) return hexToken(named)?.toLowerCase()
  if (perAssetFile && lines.length === 1) return hexToken(lines[0])?.toLowerCase()
  return undefined
}

/** Pure: roll back after N consecutive failed health probes. */
export function shouldRollback(consecutiveFailures: number, threshold = 3): boolean {
  return consecutiveFailures >= threshold
}

const stateFile = () => path.join(config.ompDir, 'update-state.json')
const versionsDir = () => path.join(config.ompDir, 'versions')
const currentLink = () => path.join(config.ompDir, 'current')
const previousLink = () => path.join(config.ompDir, 'previous')

export class OmpUpdater extends EventEmitter {
  private state: UpdateState = {
    currentVersion: null,
    previousVersion: null,
    channel: config.ompUpdate.channel,
    lastCheckedAt: null,
    lastError: null,
    latestUpstream: null,
    repo: null
  }
  private consecutiveFailures = 0
  private timer: NodeJS.Timeout | null = null
  private pendingRelease: ReleaseInfo | null = null
  private idleRetryRegistered = false
  private checkInFlight: Promise<void> | null = null

  constructor(
    private readonly hooks: {
      /** true only when no generation is in flight — we never swap mid-request. */
      isIdle: () => boolean
      /** Run once when generation becomes idle. */
      onIdleOnce: (cb: () => void) => void
      /** probe the runtime after a swap; e.g. RPC handshake. */
      healthProbe: () => Promise<boolean>
      log: (msg: string) => void
    }
  ) {
    super()
  }

  private emitUpdate(phase: OmpUpdatePhase, version: string | null = null, error?: unknown): void {
    const event: OmpUpdateEvent = { phase, version, state: this.getState() }
    if (error !== undefined) event.error = error instanceof Error ? error.message : String(error)
    this.emit('update', event)
  }

  getState(): UpdateState {
    return { ...this.state, repo: this.effectiveRepo() }
  }

  async init(): Promise<void> {
    await fsp.mkdir(versionsDir(), { recursive: true })
    try {
      this.state = { ...this.state, ...JSON.parse(await fsp.readFile(stateFile(), 'utf-8')) }
      if (this.state.repo) this.state.repo = normalizeRepoInput(this.state.repo)
    } catch {
      // Invalid/legacy repo state must not prevent the local service from
      // starting. Clearing the override falls back to the official source.
      this.state.repo = null
      await this.persist()
    }
  }

  private async persist(): Promise<void> {
    await fsp.mkdir(config.ompDir, { recursive: true })
    await fsp.writeFile(stateFile(), JSON.stringify(this.state, null, 2))
  }

  /** UI-configured repo wins; falls back to the OMP_GITHUB_REPO env. */
  effectiveRepo(): string | null {
    const configured = this.state.repo ?? (config.ompUpdate.githubRepo || null)
    return configured ? normalizeRepoInput(configured) : null
  }

  async setRepo(repo: string | null): Promise<void> {
    this.state = { ...this.state, repo: repo ? normalizeRepoInput(repo) : null }
    await this.persist()
    this.stopLoop()
    if (this.effectiveRepo()) this.startLoop()
  }

  startLoop(): void {
    if (!this.effectiveRepo()) {
      this.hooks.log('OMP 更新器未启用: 未配置上游仓库(可在界面 OMP 区域配置)')
      return
    }
    if (this.timer) return
    const tick = () => this.checkOnce().catch((e) => this.hooks.log(`更新检查失败: ${e.message}`))
    this.timer = setInterval(tick, config.ompUpdate.checkIntervalMs)
    tick()
  }

  stopLoop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async fetchLatestRelease(): Promise<ReleaseInfo | null> {
    const repo = this.effectiveRepo()
    if (!repo) return null
    const res = await requestFollowingRedirects(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'user-agent': 'botcf-local', accept: 'application/vnd.github+json' },
      headersTimeout: 30_000,
      bodyTimeout: 30_000
    })
    if (res.statusCode !== 200) {
      await res.body.dump()
      throw new Error(`GitHub Release 检查失败 HTTP ${res.statusCode}`)
    }
    const rel = (await res.body.json()) as {
      tag_name: string
      published_at: string
      assets: Array<{ name: string; browser_download_url: string; digest?: string | null }>
    }
    const asset = pickReleaseAsset(rel.assets)
    if (!asset) return null

    let sha256 = sha256FromAssetDigest(asset.digest)
    const sums = sha256 ? null : findChecksumAsset(rel.assets, asset.name)
    if (sums) {
      const sumsRes = await requestFollowingRedirects(sums.browser_download_url, {
        headers: { 'user-agent': 'botcf-local' },
        headersTimeout: 30_000,
        bodyTimeout: 30_000
      })
      if (sumsRes.statusCode === 200) {
        const perAssetFile = sums.name.toLowerCase().startsWith(asset.name.toLowerCase())
        sha256 = extractSha256FromSums(await sumsRes.body.text(), asset.name, perAssetFile)
      } else {
        await sumsRes.body.dump()
      }
    }
    if (!sha256) {
      this.hooks.log(`Release ${rel.tag_name} 资产: ${rel.assets.map((a) => a.name).join(', ') || '(无)'};选中 ${asset.name},未解析到 SHA256`)
    }
    return { version: rel.tag_name, publishedAt: Date.parse(rel.published_at), assetUrl: asset.browser_download_url, sha256 }
  }

  async checkOnce(): Promise<void> {
    if (this.checkInFlight) return this.checkInFlight
    const running = this.runCheckOnce()
    this.checkInFlight = running
    try {
      await running
    } finally {
      if (this.checkInFlight === running) this.checkInFlight = null
    }
  }

  private async runCheckOnce(): Promise<void> {
    this.state.lastCheckedAt = Date.now()
    let release: ReleaseInfo | null = null
    try {
      release = this.pendingRelease ?? await this.fetchLatestRelease()
      this.pendingRelease = null
      if (!release) throw new Error('上游 Release 中没有当前平台可用的 OMP 资产')
      this.state.latestUpstream = release.version
      this.state.lastError = null
      await this.persist()
      if (release.version === this.state.currentVersion) return
      this.emitUpdate('found', release.version)
      // The channel delay is for upgrades. A fresh installation must become
      // usable on its first launch instead of waiting for the fast window.
      if (this.state.currentVersion !== null && !releaseEligible(release.publishedAt, this.state.channel, Date.now())) {
        this.hooks.log(`发现 ${release.version},等待 ${this.state.channel} 通道延迟窗口`)
        this.emitUpdate('waiting-delay', release.version)
        return
      }
      if (!this.hooks.isIdle()) {
        this.pendingRelease = release
        this.hooks.log(`发现 ${release.version},等待会话空闲后切换`)
        this.emitUpdate('waiting-idle', release.version)
        if (!this.idleRetryRegistered) {
          this.idleRetryRegistered = true
          this.hooks.onIdleOnce(() => {
            this.idleRetryRegistered = false
            void this.checkOnce().catch((error) => this.hooks.log(`更新检查失败: ${error instanceof Error ? error.message : String(error)}`))
          })
        }
        return
      }
      await this.installAndSwap(release)
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error)
      await this.persist()
      this.emitUpdate('error', release?.version ?? null, error)
      this.hooks.log(`OMP 更新失败: ${this.state.lastError}`)
    }
  }

  async installAndSwap(release: ReleaseInfo): Promise<void> {
    if (!this.hooks.isIdle()) {
      this.pendingRelease = release
      this.emitUpdate('waiting-idle', release.version)
      return
    }
    const version = validateReleaseVersion(release.version)
    const expectedHash = normalizeReleaseSha256(release.sha256)
    const targetDir = path.join(versionsDir(), version)
    const binName = process.platform === 'win32' ? 'omp.exe' : 'omp'
    const binPath = path.join(targetDir, binName)

    if (!fs.existsSync(binPath)) {
      this.emitUpdate('downloading', version)
      await fsp.mkdir(targetDir, { recursive: true })
      const tmp = binPath + '.download'
      await fsp.rm(tmp, { force: true })
      try {
        const res = await requestFollowingRedirects(release.assetUrl, {
          headers: { 'user-agent': 'botcf-local' },
          headersTimeout: 30_000,
          bodyTimeout: 5 * 60_000
        })
        if (res.statusCode !== 200) {
          await res.body.dump()
          throw new Error(`下载失败 HTTP ${res.statusCode}`)
        }
        const hash = crypto.createHash('sha256')
        await pipeline(res.body, async function* (source) {
          for await (const chunk of source) { hash.update(chunk as Buffer); yield chunk }
        }, fs.createWriteStream(tmp))
        this.emitUpdate('verifying', version)
        const digest = hash.digest('hex')
        if (digest !== expectedHash) {
          throw new Error(`SHA256 校验失败: 期望 ${expectedHash}, 实际 ${digest}`)
        }
        await fsp.rename(tmp, binPath)
      } catch (error) {
        await fsp.rm(tmp, { force: true })
        throw error
      }
      if (process.platform !== 'win32') await fsp.chmod(binPath, 0o755)
    } else {
      this.emitUpdate('verifying', version)
      const digest = await sha256File(binPath)
      if (digest !== expectedHash) {
        await fsp.rm(binPath, { force: true })
        throw new Error(`已有 OMP 二进制 SHA256 校验失败: 期望 ${expectedHash}, 实际 ${digest};已删除损坏缓存,下次将重新下载`)
      }
    }

    if (!this.hooks.isIdle()) throw new Error('切换前会话重新变为忙碌')
    await this.swapTo(version)
    let healthy = false
    try { healthy = await this.hooks.healthProbe() } catch (error) { this.state.lastError = `安装后冒烟失败: ${error instanceof Error ? error.message : String(error)}` }
    if (!healthy) {
      this.state.lastError ??= '安装后冒烟失败'
      this.consecutiveFailures++
      if (shouldRollback(this.consecutiveFailures, 1)) {
        const rolledBack = await this.rollback()
        const restored = rolledBack && await this.hooks.healthProbe().catch(() => false)
        if (!restored) this.state.lastError = `${this.state.lastError}; 旧版本恢复验证失败`
        await this.persist()
        return
      }
    }
    this.consecutiveFailures = 0
    this.state.lastError = null
    await this.persist()
    this.emitUpdate('switched', version)
    this.hooks.log(`OMP 已切换到 ${version}`)
  }

  private async relink(link: string, version: string): Promise<void> {
    await fsp.rm(link, { recursive: true, force: true })
    const target = path.join(versionsDir(), version)
    try {
      await fsp.symlink(target, link, 'junction')
    } catch {
      // Fallback for filesystems without symlink support: copy the directory.
      await fsp.cp(target, link, { recursive: true })
    }
  }

  async swapTo(version: string): Promise<void> {
    const next = planSwap(this.state, version)
    if (next.previousVersion) await this.relink(previousLink(), next.previousVersion)
    await this.relink(currentLink(), version)
    this.state = next
    await this.persist()
  }

  async rollback(): Promise<boolean> {
    const target = this.state.previousVersion
    if (!target) {
      this.hooks.log('无可回滚版本')
      return false
    }
    await this.swapTo(target)
    this.consecutiveFailures = 0
    this.emitUpdate('rolled-back', target)
    this.hooks.log(`已回滚到 ${target}`)
    return true
  }

  /** Manual rollback. Relinking `current` alone leaves the *running* process on
   *  the old version, so `currentVersion` in the API would describe a binary
   *  nobody is executing. This runs the same transaction the automatic update
   *  uses — swap, restart, handshake, re-apply the route, real prompt — and
   *  swaps back to the version we came from when that verification fails. */
  async rollbackVerified(): Promise<{ ok: boolean; error?: string }> {
    if (!this.state.previousVersion) return { ok: false, error: '无可回滚版本' }
    if (!this.hooks.isIdle()) return { ok: false, error: '会话正在生成中,请先结束当前对话再回滚' }
    const from = this.state.currentVersion
    const target = this.state.previousVersion
    // Cleared before the event goes out: a stale error would make the UI read
    // this deliberate rollback as an automatic health-failure rollback.
    this.state.lastError = null
    if (!(await this.rollback())) return { ok: false, error: '无可回滚版本' }

    let healthy = false
    let reason = '回滚后冒烟失败'
    try {
      healthy = await this.hooks.healthProbe()
    } catch (error) {
      reason = `回滚后冒烟失败: ${error instanceof Error ? error.message : String(error)}`
    }
    if (healthy) {
      this.state.lastError = null
      await this.persist()
      return { ok: true }
    }

    if (!from) {
      this.state.lastError = reason
      await this.persist()
      return { ok: false, error: reason }
    }
    // Back to the version that was running before the user asked for a rollback.
    await this.swapTo(from)
    const restored = await this.hooks.healthProbe().catch(() => false)
    const error = restored
      ? `${reason};已切回 ${from}`
      : `${reason};切回 ${from} 后验证同样失败,OMP 已停止`
    this.state.lastError = error
    await this.persist()
    // The 'rolled-back' frame already told the UI it was on `target`; without
    // this correction the version shown would outlive the swap back.
    this.emitUpdate('error', from, error)
    this.hooks.log(`回滚到 ${target} 失败,${restored ? '已切回' : '切回未通过验证'} ${from}`)
    return { ok: false, error }
  }

  async setChannel(channel: UpdateState['channel']): Promise<void> {
    this.state = { ...this.state, channel }
    await this.persist()
    this.emitUpdate('found', this.state.latestUpstream)
  }
}
