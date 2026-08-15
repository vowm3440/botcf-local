import { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import { OmpUpdater, normalizeRepoInput } from '../omp/updater.js'
import { ompClient, ompBinaryPath } from '../omp/rpc.js'
import { getSecret, putSecret } from '../db.js'
import { seal, open } from '../secure/store.js'

const WORKDIR_SECRET = 'omp.workdir'

export function restoreWorkdir(): void {
  const sealed = getSecret(WORKDIR_SECRET)
  if (!sealed) return
  try {
    const dir = open(sealed)
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      ompClient.workdir = dir
    }
  } catch {
    /* corrupt entry — keep default cwd */
  }
}

export function registerOmpRoutes(app: FastifyInstance, updater: OmpUpdater): void {
  app.get('/api/omp/status', async () => ({
    success: true,
    binaryPath: ompBinaryPath(),
    available: ompClient.available,
    running: ompClient.running,
    protocolError: ompClient.lastProtocolError,
    workdir: ompClient.workdir,
    update: updater.getState()
  }))

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
      if (t === 'extension_ui_request' || t === 'extension_error' || t === 'notice' || t === 'host_tool_call') {
        reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`)
      }
    }
    const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    ompClient.on('event', forward)
    req.raw.on('close', () => {
      clearInterval(keepalive)
      ompClient.off('event', forward)
    })
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

  /** Choose the agent's working directory (the user's project). */
  app.post<{ Body: { path: string } }>('/api/omp/workdir', async (req, reply) => {
    const dir = (req.body?.path ?? '').trim()
    if (!dir) return reply.code(400).send({ success: false, error: '缺少目录路径' })
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return reply.code(400).send({ success: false, error: `目录不存在: ${dir}` })
    }
    putSecret(WORKDIR_SECRET, seal(dir))
    ompClient.workdir = dir
    let restarted = false
    if (ompClient.available) {
      await ompClient.stop()
      const started = await ompClient.start()
      restarted = started ? await ompClient.handshake() : false
    }
    return { success: true, workdir: dir, restarted }
  })

  app.post('/api/omp/restart', async () => {
    await ompClient.stop()
    const started = await ompClient.start()
    const ok = started ? await ompClient.handshake() : false
    return {
      success: ok,
      running: ompClient.running,
      protocolError: ompClient.lastProtocolError,
      error: ok ? undefined : (ompClient.lastProtocolError ?? 'OMP 二进制不存在或无法启动')
    }
  })

  app.post('/api/omp/check-update', async () => {
    await updater.checkOnce()
    return { success: true, update: updater.getState() }
  })

  app.post('/api/omp/rollback', async () => {
    const ok = await updater.rollback()
    return { success: ok, update: updater.getState() }
  })

  app.post<{ Body: { channel: 'fast' | 'stable' | 'experimental' } }>('/api/omp/channel', async (req, reply) => {
    const channel = req.body?.channel
    if (!['fast', 'stable', 'experimental'].includes(channel)) {
      return reply.code(400).send({ success: false, error: 'channel 必须是 fast/stable/experimental' })
    }
    await updater.setChannel(channel)
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
