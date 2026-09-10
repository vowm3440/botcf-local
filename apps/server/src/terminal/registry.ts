import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { onShutdown } from '../process/shutdown.js'
import { config } from '../config.js'
import { TerminalSession, type TerminalLine, type TerminalSessionInfo, type TerminalSessionOptions } from './session.js'
import { resolveShell, type ShellKind } from './shell.js'
import { removeTranscriptFile, transcriptFile } from '../logs/transcripts.js'

/** Owner of the live terminal sessions.
 *
 *  A session is always bound to a workspace root: the caller resolves the root
 *  first (routes/terminal.ts), so the HTTP layer can only ever open a shell in a
 *  directory the user added to the workspace. Live sessions are capped, exited
 *  ones linger so their transcript stays readable, and everything is killed on
 *  shutdown — an orphaned shell would keep the directory and its ports busy. */

export const MAX_LIVE_SESSIONS = 4
/** Exited sessions kept for their transcript before the oldest is dropped. */
const MAX_EXITED_SESSIONS = 4

export interface CreateSessionInput {
  rootId: string
  rootName: string
  cwd: string
  /** Preference from the project config; an inapplicable one falls back. */
  shell?: ShellKind | null
  env?: Readonly<Record<string, string>>
}

export type CreateSessionResult =
  | { ok: true; session: TerminalSession }
  | { ok: false; status: number; error: string }

export class TerminalRegistry extends EventEmitter {
  private sessions = new Map<string, TerminalSession>()
  private readonly makeSession: (options: TerminalSessionOptions) => TerminalSession

  constructor(
    /** Where full session transcripts are written (<dataDir>/logs/terminals). */
    private readonly transcriptsDir?: string,
    makeSession: (options: TerminalSessionOptions) => TerminalSession = (options) => new TerminalSession(options)
  ) {
    super()
    this.makeSession = makeSession
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info())
  }

  get(id: string): TerminalSession | null {
    return this.sessions.get(id) ?? null
  }

  private liveCount(): number {
    return [...this.sessions.values()].filter((session) => session.running).length
  }

  /** Forget a session and its full transcript file. */
  private drop(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    if (this.transcriptsDir) removeTranscriptFile(this.transcriptsDir, 'terminals', session.rootId, id)
  }

  /** Drop the oldest exited sessions once too many transcripts pile up. */
  private pruneExited(): void {
    const exited = [...this.sessions.values()]
      .filter((session) => !session.running)
      .sort((a, b) => a.info().lastActivityAt - b.info().lastActivityAt)
    for (const session of exited.slice(0, Math.max(0, exited.length - MAX_EXITED_SESSIONS))) {
      this.drop(session.id)
    }
  }

  create(input: CreateSessionInput): CreateSessionResult {
    if (this.liveCount() >= MAX_LIVE_SESSIONS) {
      return { ok: false, status: 409, error: `最多同时开 ${MAX_LIVE_SESSIONS} 个终端会话,请先关闭一个` }
    }
    const sessionId = `t${crypto.randomBytes(6).toString('hex')}`
    const session = this.makeSession({
      id: sessionId,
      rootId: input.rootId,
      rootName: input.rootName,
      cwd: input.cwd,
      shell: resolveShell(input.shell ?? null),
      ...(input.env ? { env: input.env } : {}),
      ...(this.transcriptsDir
        ? { transcriptFile: transcriptFile(this.transcriptsDir, 'terminals', input.rootId, sessionId) }
        : {})
    })
    session.on('line', (line: TerminalLine) => this.emit('line', { sessionId: session.id, line }))
    session.once('exit', (code: number | null) => {
      this.emit('exit', { sessionId: session.id, code })
      this.emit('sessions', this.list())
    })
    this.sessions.set(session.id, session)
    this.pruneExited()
    session.start()
    this.emit('sessions', this.list())
    return { ok: true, session }
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    await session.close()
    this.drop(id)
    this.emit('sessions', this.list())
    return true
  }

  /** Close every session opened in a directory that just left the workspace. */
  async closeForRoot(rootId: string): Promise<number> {
    const targets = [...this.sessions.values()].filter((session) => session.rootId === rootId)
    for (const session of targets) {
      await session.close()
      this.drop(session.id)
    }
    if (targets.length > 0) this.emit('sessions', this.list())
    return targets.length
  }

  async closeAll(): Promise<void> {
    const targets = [...this.sessions.values()]
    await Promise.allSettled(targets.map((session) => session.close()))
    for (const session of targets) this.drop(session.id)
    this.emit('sessions', this.list())
  }
}

export const terminalRegistry = new TerminalRegistry(config.dataDir)

/** Kill every shell before the control process dies. */
export function registerTerminalShutdown(registry: TerminalRegistry = terminalRegistry): void {
  onShutdown(() => registry.closeAll())
}
