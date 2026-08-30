import { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { PreviewLogLine, PreviewState, previewManager } from '../preview/manager.js'
import { PreviewMode } from '../preview/projectDetect.js'
import { ReloadKind } from '../preview/watcher.js'
import { workspaceRootInfos, type WorkspaceRootInfo } from '../workspace/locate.js'
import { primaryRoot, rootById, rootByName, sameRootPath, type WorkspaceRoot } from '../workspace/model.js'
import { getWorkspace } from '../workspace/store.js'

/** Live-preview control surface. The directory always comes from the server side
 *  — the client may only name an *open workspace root* (by id or name), never a
 *  path, so the preview host can only ever serve a project the user added to the
 *  workspace. One root is previewed at a time: the built-in host and the watcher
 *  both bind a single directory, and command mode runs one dev server.
 *
 *  The default target is the primary root (the agent's cwd), which is what the
 *  single-directory version always previewed. */

interface StartBody {
  mode?: string
  script?: string
  root?: string
}

/** Resolve the requested root, else the one currently being previewed, else the
 *  primary root. `requested` accepts a root id or its display name. */
function resolveRoot(requested?: string): WorkspaceRoot | null {
  const workspace = getWorkspace()
  const wanted = (requested ?? '').trim()
  if (wanted) return rootById(workspace, wanted) ?? rootByName(workspace, wanted)
  const hosted = previewManager.getState().workdir
  if (hosted) {
    const active = workspace.roots.find((root) => sameRootPath(root.path, hosted))
    if (active) return active
  }
  return primaryRoot(workspace)
}

interface StatusPayload {
  success: true
  state: PreviewState
  detected: ReturnType<typeof previewManager.detect> | null
  /** Directory the next start would use (or the running one). */
  workdir: string | null
  root: { id: string; name: string } | null
  roots: WorkspaceRootInfo[]
  logs: PreviewLogLine[]
}

function statusPayload(requested?: string): StatusPayload {
  const root = resolveRoot(requested)
  return {
    success: true,
    state: previewManager.getState(),
    detected: root ? previewManager.detect(root.path) : null,
    workdir: root?.path ?? null,
    root: root ? { id: root.id, name: root.name } : null,
    roots: workspaceRootInfos(getWorkspace()),
    logs: previewManager.getLogs()
  }
}

export function registerPreviewRoutes(app: FastifyInstance): void {
  /** `root` selects which workspace root to report detection for, so the panel
   *  can preview a secondary project without starting it first. */
  app.get<{ Querystring: { root?: string } }>('/api/preview/status', async (req) => statusPayload(req.query.root))

  /** Start the preview. Explicit user action: command mode runs project code. */
  app.post<{ Body: StartBody }>('/api/preview/start', async (req, reply) => {
    const rawRoot = req.body?.root
    if (rawRoot !== undefined && typeof rawRoot !== 'string') {
      return reply.code(400).send({ success: false, error: 'root 必须是字符串' })
    }
    const root = resolveRoot(rawRoot)
    if (!root) {
      return reply.code(409).send({
        success: false,
        error: rawRoot ? `工作区中没有这个目录: ${rawRoot.slice(0, 60)}` : '未设置工作目录,请先在文件面板添加项目目录'
      })
    }
    const rawMode = req.body?.mode
    if (rawMode !== undefined && rawMode !== 'static' && rawMode !== 'command') {
      return reply.code(400).send({ success: false, error: 'mode 必须是 static 或 command' })
    }
    const script = req.body?.script
    if (script !== undefined && typeof script !== 'string') {
      return reply.code(400).send({ success: false, error: 'script 必须是字符串' })
    }
    const state = await previewManager.start({
      workdir: root.path,
      mode: rawMode as PreviewMode | undefined,
      port: config.previewPort,
      host: config.host,
      ...(script ? { script } : {})
    })
    if (state.phase === 'error') {
      return reply.code(400).send({ success: false, error: state.error ?? '预览启动失败', state })
    }
    return { success: true, state, root: { id: root.id, name: root.name }, logs: previewManager.getLogs() }
  })

  app.post('/api/preview/stop', async () => ({ success: true, state: await previewManager.stop() }))

  app.post('/api/preview/reload', async (_req, reply) => {
    if (!previewManager.getState().running) {
      return reply.code(409).send({ success: false, error: '预览未运行' })
    }
    return { success: true, state: previewManager.reload() }
  })

  /** Push preview state, dev-server logs and reload pulses to the panel. */
  app.get('/api/preview/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const send = (payload: Record<string, unknown>): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    send({ type: 'preview_state', state: previewManager.getState() })
    const onState = (state: PreviewState): void => send({ type: 'preview_state', state })
    const onLog = (line: PreviewLogLine): void => send({ type: 'preview_log', ...line })
    const onReload = (event: { kind: ReloadKind; paths: string[]; at: number }): void =>
      send({ type: 'preview_reload', ...event })
    const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    previewManager.on('state', onState)
    previewManager.on('log', onLog)
    previewManager.on('reload', onReload)
    const cleanup = (): void => {
      clearInterval(keepalive)
      previewManager.off('state', onState)
      previewManager.off('log', onLog)
      previewManager.off('reload', onReload)
    }
    req.raw.once('close', cleanup)
    reply.raw.once('close', cleanup)
  })
}
