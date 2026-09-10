import { FastifyInstance, FastifyReply } from 'fastify'
import { workspaceRootInfos, type WorkspaceRootInfo } from '../workspace/locate.js'
import { MAX_WORKSPACE_ROOTS, primaryRoot, rootById } from '../workspace/model.js'
import { rootRuntime, type RootRuntimeSnapshot } from '../workspace/rootRuntime.js'
import {
  addRootToWorkspace,
  removeRootFromWorkspace,
  setPrimaryWorkspaceRoot,
  type WorkspaceMutationResult
} from '../workspace/service.js'
import { getWorkspace } from '../workspace/store.js'

/** Multi-root workspace control surface.
 *
 *  A root is a project directory the file panel, the editor and the live preview
 *  can reach. The *primary* root is additionally the agent's cwd, so switching it
 *  restarts OMP — every mutation reports whether that happened (`restarted`).
 *  Paths are only ever accepted here, never returned as browsable content; file
 *  access itself stays in routes/files.ts behind workspace containment. */

export interface WorkspacePayload {
  success: true
  roots: WorkspaceRootInfo[]
  primaryId: string | null
  /** Primary root path, i.e. OMP's cwd — the field the UI has always polled. */
  workdir: string | null
  maxRoots: number
  /** Per-root lifecycle (cold/restoring/active/background + pin + pool state). */
  runtime: RootRuntimeSnapshot
}

export function workspacePayload(): WorkspacePayload {
  const workspace = getWorkspace()
  const runtime = rootRuntime.snapshot()
  const runtimeById = new Map(runtime.roots.map((entry) => [entry.rootId, entry]))
  return {
    success: true,
    roots: workspaceRootInfos(workspace, runtimeById),
    primaryId: workspace.primaryId,
    workdir: primaryRoot(workspace)?.path ?? null,
    maxRoots: MAX_WORKSPACE_ROOTS,
    runtime
  }
}

export interface WorkspaceMutationPayload extends WorkspacePayload {
  root: { id: string; name: string; path: string } | null
  /** False when the directory was already open (adding is idempotent). */
  added: boolean
  restarted: boolean
  /** Set when the cwd changed but the agent runtime could not be brought back
   *  carrying the active route; the workspace change itself still applied. */
  runtimeError: string | null
}

/** Map a service result onto the wire, so every mutation answers the same shape. */
function sendMutation(reply: FastifyReply, result: WorkspaceMutationResult): WorkspaceMutationPayload | FastifyReply {
  if (!result.ok) return reply.code(result.status).send({ success: false, error: result.error })
  return {
    ...workspacePayload(),
    root: result.root ? { id: result.root.id, name: result.root.name, path: result.root.path } : null,
    added: result.added,
    restarted: result.restarted,
    runtimeError: result.runtimeError
  }
}

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  app.get('/api/workspace', async () => workspacePayload())

  /** Lifecycle snapshot: which roots are active / background / cold, whether
   *  their runtimes are running, and how many pool slots are in use. */
  app.get('/api/workspace/runtime', async () => ({ success: true, ...rootRuntime.snapshot() }))

  /** Pin (or unpin) a root so its OMP session is never recycled by the idle
   *  sweep. Pinning more roots than the pool capacity is what makes a later
   *  activation queue instead of spawning. */
  app.post<{ Body: { id?: string; pinned?: boolean } }>('/api/workspace/runtime/pin', async (req, reply) => {
    const id = typeof req.body?.id === 'string' ? req.body.id.trim() : ''
    const pinned = req.body?.pinned === true
    if (!id) return reply.code(400).send({ success: false, error: '缺少目录 id' })
    if (!rootById(getWorkspace(), id)) return reply.code(404).send({ success: false, error: '工作区中没有这个目录' })
    rootRuntime.setPinned(id, pinned)
    return workspacePayload()
  })

  /** Open a directory as a root. Idempotent; `primary` also makes it the cwd. */
  app.post<{ Body: { path?: string; name?: string; primary?: boolean } }>('/api/workspace/roots', async (req, reply) => {
    const { path: dir, name, primary } = req.body ?? {}
    if (typeof dir !== 'string' || dir.trim() === '') {
      return reply.code(400).send({ success: false, error: '缺少目录路径' })
    }
    if (name !== undefined && typeof name !== 'string') {
      return reply.code(400).send({ success: false, error: 'name 必须是字符串' })
    }
    return sendMutation(reply, await addRootToWorkspace({
      path: dir,
      ...(name ? { name } : {}),
      primary: primary === true
    }))
  })

  app.post<{ Body: { id?: string } }>('/api/workspace/roots/remove', async (req, reply) => {
    const id = req.body?.id
    if (typeof id !== 'string' || id.trim() === '') {
      return reply.code(400).send({ success: false, error: '缺少目录 id' })
    }
    return sendMutation(reply, await removeRootFromWorkspace(id.trim()))
  })

  /** Switch the agent's working directory to another open root (restarts OMP). */
  app.post<{ Body: { id?: string } }>('/api/workspace/primary', async (req, reply) => {
    const id = req.body?.id
    if (typeof id !== 'string' || id.trim() === '') {
      return reply.code(400).send({ success: false, error: '缺少目录 id' })
    }
    return sendMutation(reply, await setPrimaryWorkspaceRoot(id.trim()))
  })
}
