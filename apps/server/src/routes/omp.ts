import { FastifyInstance } from 'fastify'
import { OmpUpdateEvent, OmpUpdater, normalizeRepoInput } from '../omp/updater.js'
import { appEvents, type StateChangedEvent } from '../appEvents.js'
import { ompClient, ompBinaryPath } from '../omp/rpc.js'
import { readyDurationStats } from '../omp/startupBudget.js'
import { restartRuntime } from '../omp/runtime.js'
import { autoApprovalLabel, getAccessMode, installAutoApproval, setAccessMode, shouldAutoApprove, type AccessMode } from '../omp/access.js'
import { workspacePayload } from './workspace.js'
import { addRootToWorkspace } from '../workspace/service.js'

export function registerOmpRoutes(app: FastifyInstance, updater: OmpUpdater): void {
  // Before any SSE client can subscribe, so the approver always runs ahead of
  // the forwarders that decide whether to show the dialog.
  installAutoApproval(ompClient)

  app.get('/api/omp/status', async () => {
    const snapshot = workspacePayload()
    const budget = ompClient.budget()
    return {
      success: true,
      binaryPath: ompBinaryPath(),
      available: ompClient.available,
      running: ompClient.running,
      protocolError: ompClient.lastProtocolError,
      accessMode: getAccessMode(),
      /** The handshake ceilings in force and what startup actually cost, so a
       *  slow machine is diagnosable and the next budget change can be read off
       *  percentiles instead of guessed. */
      startup: {
        profile: budget.profile,
        reason: budget.reason,
        readyTimeoutMs: budget.readyMs,
        stateTimeoutMs: budget.stateMs,
        lastReadyMs: ompClient.lastReadyMs,
        ready: readyDurationStats()
      },
      // Primary root — OMP's cwd. The full root list travels alongside it, so the
      // top bar can show the workspace without a second request.
      workdir: snapshot.workdir,
      workspace: { roots: snapshot.roots, primaryId: snapshot.primaryId, maxRoots: snapshot.maxRoots },
      update: updater.getState()
    }
  })

  /** Read/write the tool-approval mode. `full` answers OMP's confirm dialogs
   *  automatically; it does not change what the agent is able to do. */
  app.get('/api/omp/access', async () => ({ success: true, accessMode: getAccessMode() }))

  app.post<{ Body: { accessMode?: string; fullAccess?: boolean } }>('/api/omp/access', async (req, reply) => {
    const body = req.body ?? {}
    const requested: string | undefined =
      typeof body.accessMode === 'string' ? body.accessMode
        : typeof body.fullAccess === 'boolean' ? (body.fullAccess ? 'full' : 'ask')
          : undefined
    if (requested !== 'ask' && requested !== 'full') {
      return reply.code(400).send({ success: false, error: 'accessMode 必须是 ask 或 full' })
    }
    setAccessMode(requested as AccessMode)
    return { success: true, accessMode: getAccessMode() }
  })

  /** Persistent event channel: extension-UI requests and notices can arrive at
   *  any time, not only during a chat stream. */
  app.get('/api/omp/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    reply.raw.write(': connected\n\n')
    const forward = (msg: Record<string, unknown>): void => {
      const t = msg.type as string
      // Under full access the confirm question was already answered; forwarding
      // it would open a modal over a run that is no longer waiting.
      if (shouldAutoApprove(msg, getAccessMode())) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'notice', level: 'info', text: autoApprovalLabel(msg) })}\n\n`)
        return
      }
      if (t === 'extension_ui_request' || t === 'extension_error' || t === 'notice' || t === 'host_tool_call') {
        reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`)
      }
    }
    const forwardUpdate = (event: OmpUpdateEvent): void => {
      reply.raw.write(`data: ${JSON.stringify({ type: 'omp_update', ...event })}\n\n`)
    }
    // Startup route restoration finishes after this connection exists; without
    // the push the page keeps whatever it read on mount.
    const forwardState = (event: StateChangedEvent): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    ompClient.on('event', forward)
    updater.on('update', forwardUpdate)
    appEvents.on('state', forwardState)
    const cleanup = (): void => {
      clearInterval(keepalive)
      ompClient.off('event', forward)
      updater.off('update', forwardUpdate)
      appEvents.off('state', forwardState)
    }
    req.raw.once('close', cleanup)
    reply.raw.once('close', cleanup)
  })

  /** Answer an extension UI dialog (confirm/select/input/editor). */
  app.post<{ Body: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean } }>(
    '/api/omp/ui-response',
    async (req, reply) => {
      const { id, value, confirmed, cancelled } = req.body ?? ({} as never)
      if (!id) return reply.code(400).send({ success: false, error: '缺少 id' })
      if (!ompClient.running) return reply.code(409).send({ success: false, error: 'OMP 未运行' })
      const frame: Record<string, unknown> = { type: 'extension_ui_response', id }
      if (cancelled) frame.cancelled = true
      else if (typeof confirmed === 'boolean') frame.confirmed = confirmed
      else frame.value = value ?? ''
      ompClient.sendFrame(frame)
      return { success: true }
    }
  )

  /** Choose the agent's working directory. Kept for compatibility with the
   *  single-directory era: the directory is opened as a workspace root (if it is
   *  not one already) and becomes the primary root, i.e. OMP's cwd. Other roots
   *  stay open — use /api/workspace/roots/remove to close one. */
  app.post<{ Body: { path: string } }>('/api/omp/workdir', async (req, reply) => {
    const result = await addRootToWorkspace({ path: req.body?.path ?? '', primary: true })
    if (!result.ok) return reply.code(result.status).send({ success: false, error: result.error })
    return {
      ...workspacePayload(),
      workdir: result.root?.path ?? null,
      restarted: result.restarted,
      runtimeError: result.runtimeError
    }
  })

  /** Explicit restart. Goes through the shared runtime entry point, so it also
   *  re-applies and verifies the active route — a handshake alone would leave OMP
   *  on whatever model it persisted, and the proxy answers 409 to the mismatch. */
  app.post('/api/omp/restart', async () => {
    const result = await restartRuntime()
    const ok = result.status === 'restarted'
    return {
      success: ok,
      running: ompClient.running,
      protocolError: ompClient.lastProtocolError,
      error: ok ? undefined : (result.error ?? 'OMP 二进制不存在或无法启动')
    }
  })

  app.post('/api/omp/check-update', async () => {
    await updater.checkOnce()
    return { success: true, update: updater.getState() }
  })

  /** Manual rollback is a full hot-swap transaction (restart + handshake +
   *  route + prompt), not a symlink change: reporting success before the new
   *  binary actually serves the active route is how the API and the running
   *  process drifted apart. */
  app.post('/api/omp/rollback', async (req, reply) => {
    const result = await updater.rollbackVerified()
    if (!result.ok) {
      return reply.code(409).send({ success: false, error: result.error ?? '回滚失败', update: updater.getState() })
    }
    return { success: true, update: updater.getState() }
  })

  app.post<{ Body: { channel: 'fast' | 'stable' | 'experimental' } }>('/api/omp/channel', async (req, reply) => {
    const channel = req.body?.channel
    if (!['fast', 'stable', 'experimental'].includes(channel)) {
      return reply.code(400).send({ success: false, error: 'channel 必须是 fast/stable/experimental' })
    }
    await updater.setChannel(channel)
    // A shorter-delay channel may make the pending release eligible right now.
    await updater.checkOnce().catch(() => undefined)
    return { success: true, update: updater.getState() }
  })

  app.post<{ Body: { repo: string } }>('/api/omp/repo', async (req, reply) => {
    const repo = normalizeRepoInput(req.body?.repo ?? '')
    if (repo === '') {
      await updater.setRepo(null)
      return { success: true, update: updater.getState() }
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      return reply.code(400).send({ success: false, error: `仓库格式应为 owner/repo(收到: ${repo.slice(0, 60)})` })
    }
    await updater.setRepo(repo)
    await updater.checkOnce().catch(() => undefined)
    return { success: true, update: updater.getState() }
  })
}
