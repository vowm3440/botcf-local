import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { cleanOutputLine } from '../process/ansi.js'
import { killTree } from '../process/killTree.js'
import { redact } from '../secure/redact.js'
import { TranscriptSink } from '../logs/transcripts.js'
import type { ShellSpec } from './shell.js'

/** One built-in terminal session: a real shell reading commands from stdin, its
 *  output captured line by line into a bounded ring buffer that every attached
 *  panel replays from.
 *
 *  There is no PTY in this stack (no native modules), and that shapes the
 *  feature honestly: line-oriented commands work, while full-screen/TUI programs
 *  (vim, top), password prompts and Ctrl-C-inside-a-command do not. A partial
 *  line is flushed after a short idle gap anyway, so ordinary prompts still show
 *  up instead of hanging invisibly in the buffer.
 *
 *  The session is confined to a workspace root: the caller passes an already
 *  resolved root directory as cwd, and nothing here accepts a command line — only
 *  text typed into the shell's stdin, which is what a terminal is. */

export type TerminalLineKind = 'stdout' | 'stderr' | 'input' | 'system'

export interface TerminalLine {
  /** Monotonic per session, so a reconnecting client can resume precisely. */
  seq: number
  at: number
  kind: TerminalLineKind
  text: string
}

export const MAX_TERMINAL_LINES = 1_500
export const MAX_LINE_CHARS = 4_000
export const MAX_INPUT_CHARS = 4_000
/** Idle gap after which a line without a trailing newline is flushed anyway. */
const PARTIAL_FLUSH_MS = 150

export interface TerminalSessionOptions {
  id: string
  rootId: string
  rootName: string
  cwd: string
  shell: ShellSpec
  /** Extra environment from the project config; cannot override cwd or PATH. */
  env?: Readonly<Record<string, string>>
  /** Full plain-text transcript path, when disk persistence is enabled. */
  transcriptFile?: string
  spawnProcess?: typeof spawn
}

export interface TerminalSessionInfo {
  id: string
  rootId: string
  rootName: string
  cwd: string
  shell: string
  shellKind: string
  running: boolean
  exitCode: number | null
  startedAt: number
  lastActivityAt: number
  /** Highest line sequence number, i.e. how much output exists. */
  lastSeq: number
}

export class TerminalSession extends EventEmitter {
  readonly id: string
  readonly rootId: string
  readonly rootName: string
  readonly cwd: string
  readonly shell: ShellSpec
  readonly startedAt = Date.now()

  private child: ChildProcess | null = null
  private lines: TerminalLine[] = []
  private seq = 0
  private lastActivityAt = Date.now()
  private exitCode: number | null = null
  private closing = false
  private pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  private flushTimers: Partial<Record<'stdout' | 'stderr', NodeJS.Timeout>> = {}
  private transcript: TranscriptSink | null

  constructor(private readonly options: TerminalSessionOptions) {
    super()
    this.id = options.id
    this.rootId = options.rootId
    this.rootName = options.rootName
    this.cwd = options.cwd
    this.shell = options.shell
    this.transcript = options.transcriptFile ? new TranscriptSink(options.transcriptFile) : null
  }

  get running(): boolean {
    return this.child !== null && this.exitCode === null && !this.closing
  }

  info(): TerminalSessionInfo {
    return {
      id: this.id,
      rootId: this.rootId,
      rootName: this.rootName,
      cwd: this.cwd,
      shell: this.shell.label,
      shellKind: this.shell.kind,
      running: this.running,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      lastSeq: this.seq
    }
  }

  snapshot(): TerminalLine[] {
    return [...this.lines]
  }

  /** Lines a reconnecting client has not seen yet. */
  linesAfter(seq: number): TerminalLine[] {
    return this.lines.filter((line) => line.seq > seq)
  }

  start(): void {
    if (this.child) return
    const spawnProcess = this.options.spawnProcess ?? spawn
    const isWindows = process.platform === 'win32'
    let child: ChildProcess
    try {
      child = spawnProcess(this.shell.file, this.shell.args, {
        cwd: this.cwd,
        env: {
          ...process.env,
          ...this.options.env,
          // Keep the captured transcript readable: no colours, no pagers, no
          // program deciding it can draw a full-screen UI.
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TERM: 'dumb',
          PAGER: 'cat',
          GIT_PAGER: 'cat',
          CI: '1'
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: own process group, so a stray pipeline dies with the session.
        detached: !isWindows
      })
    } catch (err: unknown) {
      this.push('system', `无法启动 ${this.shell.label}: ${err instanceof Error ? err.message : String(err)}`)
      this.push('system', `无法启动 ${this.shell.label}: ${err instanceof Error ? err.message : String(err)}`)
      this.closeTranscript()
      this.exitCode = -1
      this.emit('exit', -1)
      return
    }
    this.child = child
    this.push('system', `${this.shell.label} · ${this.cwd}`)

    this.consume(child.stdout, 'stdout')
    this.consume(child.stderr, 'stderr')

    child.on('error', (err: Error) => {
      this.push('system', `进程错误: ${err.message}`)
    })
    // Failed spawns emit error + close, but no exit; close also drains stdio.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.flush('stdout')
      this.flush('stderr')
      this.child = null
      this.exitCode = code ?? -1
      this.push('system', `会话已结束 (${signal ? `signal=${signal}` : `code=${code ?? 'unknown'}`})`)
      this.push('system', `会话已结束 (${signal ? `signal=${signal}` : `code=${code ?? 'unknown'}`})`)
      this.closeTranscript()
      this.emit('exit', this.exitCode)
    })
  }

  /** Send a command line to the shell. The text is echoed into the transcript
   *  first, so every attached panel shows the same history. */
  write(text: string): { ok: true } | { ok: false; error: string } {
    if (typeof text !== 'string') return { ok: false, error: '输入必须是字符串' }
    if (text.includes('\0')) return { ok: false, error: '输入包含非法字符' }
    if (text.length > MAX_INPUT_CHARS) return { ok: false, error: `单次输入不能超过 ${MAX_INPUT_CHARS} 字符` }
    const child = this.child
    if (!child?.stdin || !this.running) return { ok: false, error: '会话已结束,请新建一个终端会话' }
    const line = text.endsWith('\n') ? text : `${text}\n`
    this.push('input', text.replace(/\n$/, ''))
    try {
      child.stdin.write(line)
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : '写入失败' }
    }
    return { ok: true }
  }

  /** Interrupt the running work. Without a PTY there is no Ctrl-C to deliver, so
   *  this signals the whole process group (POSIX) or kills the tree (Windows):
   *  the session usually ends, and the panel offers a new one. */
  async interrupt(): Promise<void> {
    const child = this.child
    if (!child?.pid || !this.running) return
    this.push('system', '已发送中断信号')
    if (process.platform === 'win32') {
      await killTree(child)
      return
    }
    try {
      process.kill(-child.pid, 'SIGINT')
    } catch {
      // Group already gone.
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const child = this.child
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      // Already closed.
    }
    await killTree(child)
    this.child = null
    if (this.exitCode === null) this.exitCode = -1
    this.closeTranscript()
  }

  private consume(stream: NodeJS.ReadableStream | null, kind: 'stdout' | 'stderr'): void {
    if (!stream) return
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const combined = this.pending[kind] + chunk
      const parts = combined.split(/\r?\n/)
      this.pending[kind] = parts.pop() ?? ''
      for (const part of parts) this.push(kind, part)
      // A prompt never ends with a newline; show it once output goes quiet.
      const timer = this.flushTimers[kind]
      if (timer) clearTimeout(timer)
      if (this.pending[kind]) {
        const next = setTimeout(() => this.flush(kind), PARTIAL_FLUSH_MS)
        next.unref?.()
        this.flushTimers[kind] = next
      }
    })
  }

  private flush(kind: 'stdout' | 'stderr'): void {
    const timer = this.flushTimers[kind]
    if (timer) clearTimeout(timer)
    delete this.flushTimers[kind]
    const rest = this.pending[kind]
    if (!rest) return
    this.pending[kind] = ''
    this.push(kind, rest)
  }

  /** Flush and release the transcript file handle once the session ends. */
  private closeTranscript(): void {
    this.transcript?.close()
    this.transcript = null
  }

  private push(kind: TerminalLineKind, raw: string): void {
    const text = redact(cleanOutputLine(raw)).slice(0, MAX_LINE_CHARS)
    // Blank output lines are kept: spacing is part of a transcript.
    const line: TerminalLine = { seq: ++this.seq, at: Date.now(), kind, text }
    this.lastActivityAt = line.at
    this.lines = [...this.lines.slice(-(MAX_TERMINAL_LINES - 1)), line]
    // The ring buffer drops old lines; the transcript file keeps them all.
    this.transcript?.append(text)
    this.emit('line', line)
  }
}
