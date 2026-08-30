import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { cleanOutputLine } from '../process/ansi.js'
import { killTree } from '../process/killTree.js'
import { redact } from '../secure/redact.js'

/** One task execution: a child process, its captured output and its verdict.
 *
 *  Deliberately generic — `build`, `run` and `test` are the same mechanism with
 *  different argv, which is what makes a single task system possible instead of
 *  three half-features. The runner only executes what it is handed; deciding
 *  *what* may run (validated argv, package.json scripts) happens in tasks/model.ts
 *  and the config schema.
 *
 *  Output is a bounded ring buffer with monotonic sequence numbers, so a panel can
 *  attach late or reconnect and resume exactly where it stopped. */

export type TaskRunState = 'running' | 'succeeded' | 'failed' | 'stopped'

export interface TaskLogLine {
  seq: number
  at: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export const MAX_RUN_LINES = 1_000
const MAX_LINE_CHARS = 4_000

export interface TaskRunOptions {
  /** Run id, unique across the process. */
  id: string
  taskId: string
  taskName: string
  rootId: string
  rootName: string
  file: string
  args: readonly string[]
  /** Absolute working directory, already contained inside the root. */
  cwd: string
  env?: Readonly<Record<string, string>>
  background: boolean
  commandLine: string
  spawnProcess?: typeof spawn
}

export interface TaskRunInfo {
  id: string
  taskId: string
  taskName: string
  rootId: string
  rootName: string
  commandLine: string
  cwd: string
  background: boolean
  state: TaskRunState
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  /** Milliseconds the run took (or has taken so far). */
  durationMs: number
  lastSeq: number
  /** Diagnostics parsed out of this run's output. */
  problemCount: number
}

export class TaskRun extends EventEmitter {
  readonly id: string
  readonly taskId: string
  readonly startedAt = Date.now()

  private child: ChildProcess | null = null
  private lines: TaskLogLine[] = []
  private seq = 0
  private state: TaskRunState = 'running'
  private exitCode: number | null = null
  private endedAt: number | null = null
  private pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  private problems = 0

  constructor(private readonly options: TaskRunOptions) {
    super()
    this.id = options.id
    this.taskId = options.taskId
  }

  get running(): boolean {
    return this.state === 'running'
  }

  info(): TaskRunInfo {
    return {
      id: this.id,
      taskId: this.taskId,
      taskName: this.options.taskName,
      rootId: this.options.rootId,
      rootName: this.options.rootName,
      commandLine: this.options.commandLine,
      cwd: this.options.cwd,
      background: this.options.background,
      state: this.state,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: (this.endedAt ?? Date.now()) - this.startedAt,
      lastSeq: this.seq,
      problemCount: this.problems
    }
  }

  snapshot(): TaskLogLine[] {
    return [...this.lines]
  }

  linesAfter(seq: number): TaskLogLine[] {
    return this.lines.filter((line) => line.seq > seq)
  }

  /** Counter shown next to the run; the manager owns the diagnostics themselves. */
  countProblems(delta: number): void {
    this.problems += delta
  }

  start(): void {
    if (this.child) return
    const spawnProcess = this.options.spawnProcess ?? spawn
    const isWindows = process.platform === 'win32'
    this.push('system', `$ ${this.options.commandLine}  (cwd=${this.options.cwd})`)
    let child: ChildProcess
    try {
      child = spawnProcess(this.options.file, [...this.options.args], {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          ...this.options.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          // Keep tools from opening browsers/pagers or waiting for a TTY.
          BROWSER: 'none',
          PAGER: 'cat',
          CI: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Package-manager entry points are .cmd shims on Windows, which need a
        // shell; every argv token was charset-validated for exactly this reason.
        shell: isWindows,
        windowsHide: true,
        // POSIX: own process group, so stopping kills the whole tool tree.
        detached: !isWindows
      })
    } catch (err: unknown) {
      this.push('system', `启动失败: ${err instanceof Error ? err.message : String(err)}`)
      this.finish('failed', -1)
      return
    }
    this.child = child
    this.consume(child.stdout, 'stdout')
    this.consume(child.stderr, 'stderr')
    child.on('error', (err: Error) => this.push('system', `进程错误: ${err.message}`))
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.flush('stdout')
      this.flush('stderr')
      this.child = null
      if (this.state !== 'running') return
      if (signal) {
        this.push('system', `已终止 (signal=${signal})`)
        this.finish('stopped', code)
        return
      }
      const ok = code === 0
      this.push('system', ok ? '任务完成 (exit 0)' : `任务失败 (exit ${code ?? 'unknown'})`)
      this.finish(ok ? 'succeeded' : 'failed', code)
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) {
      if (this.state === 'running') this.finish('stopped', null)
      return
    }
    this.push('system', '正在停止…')
    // Mark first: the exit handler must not classify a deliberate stop as failure.
    this.state = 'stopped'
    await killTree(child)
    this.child = null
    this.finish('stopped', null)
  }

  private finish(state: TaskRunState, code: number | null): void {
    this.state = state
    this.exitCode = code
    this.endedAt = Date.now()
    this.emit('end', this.info())
  }

  private consume(stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr'): void {
    if (!stream) return
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const combined = this.pending[name] + chunk
      const parts = combined.split(/\r?\n/)
      this.pending[name] = parts.pop() ?? ''
      for (const part of parts) this.push(name, part)
    })
  }

  private flush(name: 'stdout' | 'stderr'): void {
    const rest = this.pending[name]
    if (!rest) return
    this.pending[name] = ''
    this.push(name, rest)
  }

  private push(stream: TaskLogLine['stream'], raw: string): void {
    const text = redact(cleanOutputLine(raw)).slice(0, MAX_LINE_CHARS)
    const line: TaskLogLine = { seq: ++this.seq, at: Date.now(), stream, text }
    this.lines = [...this.lines.slice(-(MAX_RUN_LINES - 1)), line]
    this.emit('line', line)
  }
}
