import { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import { loadProjectConfig } from '../projectConfig/store.js'
import { terminalRegistry } from '../terminal/registry.js'
import type { TerminalLine } from '../terminal/session.js'
import { SHELL_KINDS, defaultShell, isShellKind } from '../terminal/shell.js'
import { workspaceRootInfos } from '../workspace/locate.js'
import { requireWorkspaceRoot } from '../workspace/resolveRoot.js'
import { getWorkspace } from '../workspace/store.js'

/** Built-in terminal surface.
 *
 *  A session is a real shell started in one workspace root; the client names the
 *  root (id or display name) and can never pass a directory, an executable path
 *  or extra shell arguments — the shell is picked from a fixed set, optionally
 *  preselected by the project config. Everything typed afterwards goes to the
 *  shell's stdin, which is the whole point of a terminal.
 *
 *  Output is replayed from a per-session ring buffer with monotonic sequence
 *  numbers, so a panel that reconnects (or a second panel) resumes exactly where
 *  it left off instead of re-rendering the transcript. */

export function registerTerminalRoutes(app: FastifyInstance): void {
  app.get('/api/terminal/sessions', async () => ({
    success: true,
    sessions: terminalRegistry.list(),
    roots: workspaceRootInfos(getWorkspace()),
    shellKinds: SHELL_KINDS,
    platformShell: defaultShell().kind
  }))

  /** Open a shell. Explicit user action: it runs arbitrary local commands, so it
   *  is never started implicitly. */
  app.post<{ Body: { root?: string; shell?: string } }>('/api/terminal/sessions', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const { root } = resolved
    if (!fs.existsSync(root.path)) {
      return reply.code(409).send({ success: false, error: `目录不存在: ${root.path}` })
    }
    const requestedShell = req.body?.shell
    if (requestedShell !== undefined && !isShellKind(requestedShell)) {
      return reply.code(400).send({ success: false, error: `shell 必须是 ${SHELL_KINDS.join('/')}` })
    }
    const { config } = loadProjectConfig(root.path)
    const created = terminalRegistry.create({
      rootId: root.id,
      rootName: root.name,
      cwd: root.path,
      shell: requestedShell ?? config.terminal.shell,
      env: config.terminal.env
    })
    if (!created.ok) return reply.code(created.status).send({ success: false, error: created.error })
    return { success: true, session: created.session.info(), lines: created.session.snapshot() }
  })

  /** Transcript catch-up: `after` is the last sequence number already rendered. */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/terminal/sessions/:id',
    async (req, reply) => {
      const session = terminalRegistry.get(req.params.id)
      if (!session) return reply.code(404).send({ success: false, error: '终端会话不存在' })
      const after = Number(req.query.after ?? 0)
      const lines = Number.isFinite(after) && after > 0 ? session.linesAfter(after) : session.snapshot()
      return { success: true, session: session.info(), lines }
    }
  )

  app.post<{ Params: { id: string }; Body: { data?: string } }>(
    '/api/terminal/sessions/:id/input',
    async (req, reply) => {
      const session = terminalRegistry.get(req.params.id)
      if (!session) return reply.code(404).send({ success: false, error: '终端会话不存在' })
      const data = req.body?.data
      if (typeof data !== 'string') return reply.code(400).send({ success: false, error: '缺少 data' })
      const written = session.write(data)
      if (!written.ok) return reply.code(409).send({ success: false, error: written.error })
      return { success: true, session: session.info() }
    }
  )

  /** Interrupt the running work. Without a PTY this signals the process group,
   *  which usually ends the session too — the panel then offers a new one. */
  app.post<{ Params: { id: string } }>('/api/terminal/sessions/:id/interrupt', async (req, reply) => {
    const session = terminalRegistry.get(req.params.id)
    if (!session) return reply.code(404).send({ success: false, error: '终端会话不存在' })
    await session.interrupt()
    return { success: true, session: session.info() }
  })

  app.post<{ Params: { id: string } }>('/api/terminal/sessions/:id/close', async (req, reply) => {
    const closed = await terminalRegistry.close(req.params.id)
    if (!closed) return reply.code(404).send({ success: false, error: '终端会话不存在' })
    return { success: true, sessions: terminalRegistry.list() }
  })

  /** Live output for one session (or every session when `id` is omitted). */
  app.get<{ Querystring: { id?: string; after?: string } }>('/api/terminal/events', (req, reply) => {
    const wanted = req.query.id
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const send = (payload: Record<string, unknown>): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    send({ type: 'terminal_sessions', sessions: terminalRegistry.list() })
    // Replay what the client missed before subscribing, so no line is lost
    // between the snapshot request and the stream opening.
    const after = Number(req.query.after ?? 0)
    if (wanted && Number.isFinite(after) && after > 0) {
      const session = terminalRegistry.get(wanted)
      for (const line of session?.linesAfter(after) ?? []) send({ type: 'terminal_line', sessionId: wanted, line })
    }
    const onLine = ({ sessionId, line }: { sessionId: string; line: TerminalLine }): void => {
      if (wanted && sessionId !== wanted) return
      send({ type: 'terminal_line', sessionId, line })
    }
    const onExit = ({ sessionId, code }: { sessionId: string; code: number | null }): void =>
      send({ type: 'terminal_exit', sessionId, code, sessions: terminalRegistry.list() })
    const onSessions = (sessions: unknown): void => send({ type: 'terminal_sessions', sessions })
    const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    terminalRegistry.on('line', onLine)
    terminalRegistry.on('exit', onExit)
    terminalRegistry.on('sessions', onSessions)
    const cleanup = (): void => {
      clearInterval(keepalive)
      terminalRegistry.off('line', onLine)
      terminalRegistry.off('exit', onExit)
      terminalRegistry.off('sessions', onSessions)
    }
    req.raw.once('close', cleanup)
    reply.raw.once('close', cleanup)
  })
}
