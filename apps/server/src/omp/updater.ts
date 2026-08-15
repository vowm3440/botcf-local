import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { request as undiciRequest } from 'undici'
import { config } from '../config.js'

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

export const OFFICIAL_OMP_REPO = 'can1357/oh-my-pi'

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

/** Pure: roll back after N consecutive failed health probes. */
export function shouldRollback(consecutiveFailures: number, threshold = 3): boolean {
  return consecutiveFailures >= threshold
}

const stateFile = () => path.join(config.ompDir, 'update-state.json')
const versionsDir = () => path.join(config.ompDir, 'versions')
const currentLink = () => path.join(config.ompDir, 'current')
const previousLink = () => path.join(config.ompDir, 'previous')

export class OmpUpdater {
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

  constructor(
    private readonly hooks: {
      /** true only when no generation is in flight — we never swap mid-request. */
      isIdle: () => boolean
      /** probe the runtime after a swap; e.g. RPC handshake. */
      healthProbe: () => Promise<boolean>
      log: (msg: string) => void
    }
  ) {}

  getState(): UpdateState {
    return { ...this.state }
  }

  async init(): Promise<void> {
    await fsp.mkdir(versionsDir(), { recursive: true })
    try {
      this.state = { ...this.state, ...JSON.parse(await fsp.readFile(stateFile(), 'utf-8')) }
    } catch {
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
    const res = await undiciRequest(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'user-agent': 'botcf-local', accept: 'application/vnd.github+json' }
    })
    if (res.statusCode !== 200) return null
    const rel = (await res.body.json()) as {
      tag_name: string
      published_at: string
      assets: Array<{ name: string; browser_download_url: string }>
    }
    const platformKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
    const archKey = process.arch === 'arm64' ? 'arm64' : 'x64|amd64'
    const asset = rel.assets.find((a) => new RegExp(platformKey, 'i').test(a.name) && new RegExp(archKey, 'i').test(a.name))
      ?? rel.assets[0]
    if (!asset) return null

    let sha256: string | undefined
    const sums = rel.assets.find((a) => /checksums|sha256/i.test(a.name))
    if (sums) {
      const sumsRes = await undiciRequest(sums.browser_download_url, { headers: { 'user-agent': 'botcf-local' } })
      if (sumsRes.statusCode === 200) {
        const text = await sumsRes.body.text()
        const line = text.split('\n').find((l) => l.includes(asset.name))
        sha256 = line?.trim().split(/\s+/)[0]
      }
    }
    return { version: rel.tag_name, publishedAt: Date.parse(rel.published_at), assetUrl: asset.browser_download_url, sha256 }
  }

  async checkOnce(): Promise<void> {
    this.state.lastCheckedAt = Date.now()
    const release = await this.fetchLatestRelease()
    if (!release) {
      this.state.lastError = '未能获取上游 Release'
      await this.persist()
      return
    }
    this.state.latestUpstream = release.version
    this.state.lastError = null
    await this.persist()

    if (release.version === this.state.currentVersion) return
    if (!releaseEligible(release.publishedAt, this.state.channel, Date.now())) {
      this.hooks.log(`发现 ${release.version},等待 ${this.state.channel} 通道延迟窗口`)
      return
    }
    if (!this.hooks.isIdle()) {
      this.hooks.log(`发现 ${release.version},等待会话空闲后切换`)
      return
    }
    try {
      await this.installAndSwap(release)
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error)
      await this.persist()
      throw error
    }
  }

  async installAndSwap(release: ReleaseInfo): Promise<void> {
    const version = validateReleaseVersion(release.version)
    const expectedHash = normalizeReleaseSha256(release.sha256)
    const targetDir = path.join(versionsDir(), version)
    const binName = process.platform === 'win32' ? 'omp.exe' : 'omp'
    const binPath = path.join(targetDir, binName)

    if (!fs.existsSync(binPath)) {
      await fsp.mkdir(targetDir, { recursive: true })
      const tmp = binPath + '.download'
      const res = await undiciRequest(release.assetUrl, { headers: { 'user-agent': 'botcf-local' }, maxRedirections: 5 })
      if (res.statusCode !== 200) throw new Error(`下载失败 HTTP ${res.statusCode}`)
      const hash = crypto.createHash('sha256')
      await pipeline(
        res.body,
        async function* (source) {
          for await (const chunk of source) {
            hash.update(chunk as Buffer)
            yield chunk
          }
        },
        fs.createWriteStream(tmp)
      )
      const digest = hash.digest('hex')
      if (digest !== expectedHash) {
        await fsp.rm(tmp, { force: true })
        throw new Error(`SHA256 校验失败: 期望 ${expectedHash}, 实际 ${digest}`)
      }
      await fsp.rename(tmp, binPath)
      if (process.platform !== 'win32') await fsp.chmod(binPath, 0o755)
    } else {
      const digest = await sha256File(binPath)
      if (digest !== expectedHash) throw new Error(`已有 OMP 二进制 SHA256 校验失败: 期望 ${expectedHash}, 实际 ${digest}`)
    }

    await this.swapTo(version)

    let healthy = false
    try {
      healthy = await this.hooks.healthProbe()
    } catch (error) {
      this.state.lastError = `安装后冒烟失败: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!healthy) {
      this.state.lastError ??= '安装后冒烟失败'
      this.consecutiveFailures++
      if (shouldRollback(this.consecutiveFailures, 1)) {
        const rolledBack = await this.rollback()
        const restored = rolledBack && await this.hooks.healthProbe().catch(() => false)
        if (!restored) this.state.lastError = `${this.state.lastError ?? '安装后冒烟失败'}; 旧版本恢复验证失败`
        await this.persist()
        return
      }
    }
    this.consecutiveFailures = 0
    this.state.lastError = null
    await this.persist()
    this.hooks.log(`OMP 已切换到 ${release.version}`)
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
    this.hooks.log(`已回滚到 ${target}`)
    return true
  }

  async setChannel(channel: UpdateState['channel']): Promise<void> {
    this.state = { ...this.state, channel }
    await this.persist()
  }
}
