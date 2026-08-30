import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { onShutdown } from '../process/shutdown.js'
import { redact } from '../secure/redact.js'
import { DevCommandRunner } from './commandRunner.js'
import { DetectedProject, PreviewMode, detectProject } from './projectDetect.js'
import { StaticPreviewServer } from './staticPreview.js'
import { ReloadKind, WorkdirWatcher } from './watcher.js'

/** Lifecycle owner for the live-preview engine.
 *
 *  static mode  — built-in loopback host + recursive workdir watcher; CSS-only
 *                 edits hot-swap, everything else reloads. No project deps.
 *  command mode — the project's own dev server (npm run dev …) as a child
 *                 process, its URL sniffed from stdout; HMR is the project's.
 *
 *  Starting is always an explicit user action: command mode executes project
 *  code, so it must never happen implicitly on workdir selection. */

export type PreviewPhase = 'stopped' | 'starting' | 'running' | 'error'

export interface PreviewState {
  phase: PreviewPhase
  mode: PreviewMode | null
  running: boolean
  /** Browsable URL for the iframe; null until known. */
  url: string | null
  port: number | null
  script: string | null
  command: string | null
  workdir: string | null
  error: string | null
  startedAt: number | null
  lastReloadAt: number | null
  lastReloadKind: ReloadKind | null
  /** Attached preview pages (static mode only). */
  clients: number
}

export interface PreviewLogLine {
  at: number
  line: string
}

const MAX_LOG_LINES = 200

const STOPPED: PreviewState = {
  phase: 'stopped',
  mode: null,
  running: false,
  url: null,
  port: null,
  script: null,
  command: null,
  workdir: null,
  error: null,
  startedAt: null,
  lastReloadAt: null,
  lastReloadKind: null,
  clients: 0
}

export interface StartPreviewOptions {
  workdir: string
  mode?: PreviewMode
  /** package.json script for command mode; validated against the project. */
  script?: string
  /** Fixed port for static mode; 0/undefined picks an ephemeral one. */
  port?: number
  /** Bind address for the built-in host. Defaults to loopback; a container sets
   *  0.0.0.0 so a mapped port reaches the browser on the host. The advertised
   *  URL stays 127.0.0.1 either way. */
  host?: string
}

export class PreviewManager extends EventEmitter {
  private state: PreviewState = STOPPED
  private logs: PreviewLogLine[] = []
  private staticServer: StaticPreviewServer | null = null
  private watcher: WorkdirWatcher | null = null
  private runner: DevCommandRunner | null = null
  /** Serializes start/stop so overlapping clicks cannot leak a dev server. */
  private operation: Promise<unknown> = Promise.resolve()

  getState(): PreviewState {
    return { ...this.state, clients: this.staticServer?.clientCount ?? 0 }
  }

  getLogs(): PreviewLogLine[] {
    return [...this.logs]
  }

  detect(workdir: string): DetectedProject {
    return detectProject(workdir)
  }

  private patch(next: Partial<PreviewState>): void {
    this.state = { ...this.state, ...next }
    this.emit('state', this.getState())
  }

  private log(line: string): void {
    const entry: PreviewLogLine = { at: Date.now(), line: redact(line).slice(0, 2_000) }
    // Ring buffer: a chatty dev server must not grow memory without bound.
    this.logs = [...this.logs.slice(-(MAX_LOG_LINES - 1)), entry]
    this.emit('log', entry)
  }

  /** Queue an operation so start/stop never interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.then(task, task)
    this.operation = next.catch(() => undefined)
    return next
  }

  async start(options: StartPreviewOptions): Promise<PreviewState> {
    return this.enqueue(async () => {
      await this.teardown()
      const { workdir } = options
      if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
        this.patch({ ...STOPPED, phase: 'error', error: `工作目录不存在: ${workdir}` })
        return this.getState()
      }
      const detected = detectProject(workdir)
      const mode = options.mode ?? detected.mode
      this.logs = []
      this.patch({
        ...STOPPED,
        phase: 'starting',
        mode,
        workdir,
        startedAt: Date.now()
      })
      try {
        if (mode === 'command') await this.startCommand(options, detected)
        else await this.startStatic(options, detected)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        await this.teardown()
        this.patch({ ...STOPPED, phase: 'error', mode, workdir, error: message })
        this.log(`启动失败: ${message}`)
      }
      return this.getState()
    })
  }

  private async startStatic(options: StartPreviewOptions, detected: DetectedProject): Promise<void> {
    const server = new StaticPreviewServer({
      root: options.workdir,
      host: options.host,
      port: options.port ?? 0,
      entry: detected.entry
    })
    const port = await server.start()
    this.staticServer = server

    const watcher = new WorkdirWatcher(options.workdir)
    watcher.on('change', ({ kind, paths }: { kind: ReloadKind; paths: string[] }) => {
      server.broadcast(kind)
      this.patch({ lastReloadAt: Date.now(), lastReloadKind: kind })
      this.emit('reload', { kind, paths, at: Date.now() })
      this.log(`${kind === 'css' ? '样式热更新' : '重新加载'}: ${paths.slice(0, 6).join(', ')}${paths.length > 6 ? ` 等 ${paths.length} 项` : ''}`)
    })
    watcher.on('error', (message: string) => {
      this.log(`监听告警: ${message}`)
    })
    watcher.start()
    this.watcher = watcher

    this.log(`内置静态预览已启动: http://127.0.0.1:${port}/ (${detected.reason})`)
    this.patch({
      phase: 'running',
      running: true,
      url: `http://127.0.0.1:${port}/`,
      port,
      command: '内置静态服务器 + 文件监听',
      script: null,
      error: null
    })
  }

  private async startCommand(options: StartPreviewOptions, detected: DetectedProject): Promise<void> {
    const script = options.script ?? detected.script
    if (!script) throw new Error('项目没有可运行的 package.json 脚本,请改用静态模式')
    // Allowlist: only scripts this project actually declares may run. The list
    // comes from the package.json read during detection, moments ago.
    if (!detected.scripts.includes(script)) {
      throw new Error(`脚本 ${script.slice(0, 40)} 不在该项目 package.json 中`)
    }
    const runner = new DevCommandRunner({
      cwd: options.workdir,
      packageManager: detected.packageManager,
      script
    })
    runner.on('log', (line: string) => this.log(line))
    runner.on('url', (url: string) => {
      this.log(`检测到开发服务器地址 ${url}`)
      this.patch({ phase: 'running', running: true, url, error: null })
    })
    runner.on('exit', (code: number | null) => {
      const failed = code !== 0 && code !== null
      this.log(`开发服务器已退出 (code=${code ?? 'signal'})`)
      this.runner = null
      this.patch({
        phase: failed ? 'error' : 'stopped',
        running: false,
        url: null,
        error: failed ? `开发服务器退出,code=${code}` : null
      })
    })
    runner.start()
    this.runner = runner
    this.log(`已启动 ${runner.commandLine} (cwd=${options.workdir})`)
    this.patch({ command: runner.commandLine, script, error: null })
  }

  /** Force every attached preview page to reload (static mode) and tell the
   *  panel to re-create its iframe (both modes). */
  reload(): PreviewState {
    this.staticServer?.broadcast('reload')
    this.patch({ lastReloadAt: Date.now(), lastReloadKind: 'reload' })
    this.emit('reload', { kind: 'reload' as ReloadKind, paths: [], at: Date.now() })
    return this.getState()
  }

  async stop(): Promise<PreviewState> {
    return this.enqueue(async () => {
      const wasRunning = this.state.phase !== 'stopped'
      await this.teardown()
      this.patch({ ...STOPPED })
      if (wasRunning) this.log('预览已停止')
      return this.getState()
    })
  }

  private async teardown(): Promise<void> {
    const runner = this.runner
    this.runner = null
    this.watcher?.stop()
    this.watcher = null
    const server = this.staticServer
    this.staticServer = null
    if (runner) {
      runner.removeAllListeners()
      await runner.stop()
    }
    if (server) await server.stop()
  }
}

export const previewManager = new PreviewManager()

/** Stop a running dev server before the control process dies; a child dev
 *  server would otherwise keep holding its port (Windows never reaps it). The
 *  signal handling itself belongs to process/shutdown.ts, which runs every
 *  subsystem's cleanup together. */
export function registerPreviewShutdown(manager: PreviewManager = previewManager): void {
  onShutdown(() => manager.stop().then(() => undefined))
}
