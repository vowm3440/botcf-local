import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import { stripAnsi } from '../process/ansi.js'
import { killTree } from '../process/killTree.js'
import { PackageManager, scriptCommand } from './projectDetect.js'

/** Command-mode preview: run the project's own dev server as a child process
 *  and learn its URL from stdout, so the project keeps its native HMR pipeline
 *  (Vite, Next, webpack-dev-server …) instead of our simpler static reloader.
 *
 *  Only a package.json script name is ever accepted — validated against the
 *  project's own script list by the caller and against SAFE_SCRIPT_NAME here —
 *  never a free-form command line from the HTTP layer. */

/** Escape-sequence removal is shared with the task runner and the terminal,
 *  which capture the same kind of colourised child output. */
export { stripAnsi } from '../process/ansi.js'

/** Loopback dev-server URLs printed by common toolchains. */
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s"'`]*)?/i

/** Extract and normalize the first loopback URL on a dev-server log line.
 *  0.0.0.0 and [::1] are rewritten to 127.0.0.1 so the iframe can load them. */
export function sniffDevServerUrl(line: string): string | null {
  const match = URL_PATTERN.exec(stripAnsi(line))
  if (!match) return null
  try {
    const url = new URL(match[0])
    if (url.hostname === '0.0.0.0' || url.hostname === '[::1]') url.hostname = '127.0.0.1'
    return url.toString()
  } catch {
    return null
  }
}

export interface DevCommandRunnerOptions {
  cwd: string
  packageManager: PackageManager
  script: string
  spawnProcess?: typeof spawn
}

/**
 * Emits `log` per output line, `url` once a loopback URL is seen, and `exit`
 * with the exit code. Never throws asynchronously: spawn failures arrive as an
 * `exit` with a log line explaining why.
 */
export class DevCommandRunner extends EventEmitter {
  private child: ChildProcess | null = null
  private detectedUrl: string | null = null
  private stopping = false

  constructor(private readonly options: DevCommandRunnerOptions) {
    super()
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.stopping
  }

  get url(): string | null {
    return this.detectedUrl
  }

  get commandLine(): string {
    const { file, args } = scriptCommand(this.options.packageManager, this.options.script)
    return [file, ...args].join(' ')
  }

  start(): void {
    if (this.child) return
    const { file, args } = scriptCommand(this.options.packageManager, this.options.script)
    const spawnProcess = this.options.spawnProcess ?? spawn
    const isWindows = process.platform === 'win32'
    let child: ChildProcess
    try {
      child = spawnProcess(file, args, {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          // Stop dev servers from opening a real browser window, and keep the
          // captured log readable.
          BROWSER: 'none',
          FORCE_COLOR: '0',
          NO_COLOR: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // .cmd shims (npm/pnpm/yarn on Windows) require a shell; the script name
        // is validated to [A-Za-z0-9:_.-] so nothing can be injected here.
        shell: isWindows,
        windowsHide: true,
        // POSIX: own process group, so stopping kills the whole dev-server tree.
        detached: !isWindows
      })
    } catch (err: unknown) {
      this.emit('log', `启动失败: ${err instanceof Error ? err.message : String(err)}`)
      this.emit('exit', null)
      return
    }
    this.child = child

    const consume = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      const lines = readline.createInterface({ input: stream })
      lines.on('line', (raw: string) => {
        const line = stripAnsi(raw).trimEnd()
        if (line) this.emit('log', line)
        if (this.detectedUrl) return
        const url = sniffDevServerUrl(raw)
        if (url) {
          this.detectedUrl = url
          this.emit('url', url)
        }
      })
    }
    consume(child.stdout)
    consume(child.stderr)

    child.on('error', (err: Error) => {
      this.emit('log', `进程错误: ${err.message}`)
    })
    // Failed spawns emit error + close, but no exit; close also drains stdio.
    child.once('close', (code: number | null) => {
      this.child = null
      this.emit('exit', code)
    })
  }

  /** Kill the dev server and its children. Resolves once the process is gone
   *  (or after the escalation window, so a wedged tree cannot block shutdown). */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.pid === undefined) {
      this.child = null
      return
    }
    this.stopping = true
    await killTree(child)
    this.child = null
    this.stopping = false
  }
}
