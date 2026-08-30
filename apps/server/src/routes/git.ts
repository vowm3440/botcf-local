import { FastifyInstance, FastifyReply } from 'fastify'
import {
  abortRevert,
  commitStaged,
  diffOf,
  discardPaths,
  logOf,
  revertCommit,
  stagePaths,
  statusOf,
  undoLastCommit,
  unstagePaths,
  type GitOutcome,
  type UndoMode
} from '../git/service.js'
import { workspaceRootInfos } from '../workspace/locate.js'
import { requireWorkspaceRoot } from '../workspace/resolveRoot.js'
import { getWorkspace } from '../workspace/store.js'

/** Git control surface, one workspace root at a time.
 *
 *  The client names a root (`root` = id or display name, default: the primary
 *  root) and root-*relative* paths inside it; the service layer contains those
 *  paths and refuses anything that could be read as a git option. Nothing here
 *  accepts a disk path, a ref expression or a command line.
 *
 *  Two rollback shapes are exposed deliberately:
 *   - `discard` throws away uncommitted work for named files (new files only when
 *     `deleteNew` is set, since deleting cannot be undone by git);
 *   - `undo` moves the branch back one commit keeping the changes, `revert`
 *     creates an inverse commit — the safe choice once a commit is published. */

interface RootBody {
  root?: string
}

/** Map a service outcome onto the wire, so every git endpoint answers alike. */
function send<T extends object>(
  reply: FastifyReply,
  root: { id: string; name: string },
  outcome: GitOutcome<T>
): FastifyReply | ({ success: true; root: { id: string; name: string } } & T) {
  if (!outcome.ok) return reply.code(outcome.status).send({ success: false, error: outcome.error })
  return { success: true, root: { id: root.id, name: root.name }, ...outcome.data }
}

export function registerGitRoutes(app: FastifyInstance): void {
  /** Working-tree state plus the roots list, so the panel can render its picker
   *  from a single request. */
  app.get<{ Querystring: { root?: string } }>('/api/git/status', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.query.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const status = await statusOf(resolved.root.path)
    if (!status.ok) return reply.code(status.status).send({ success: false, error: status.error })
    return {
      success: true,
      root: { id: resolved.root.id, name: resolved.root.name },
      roots: workspaceRootInfos(getWorkspace()),
      ...status.data
    }
  })

  app.get<{ Querystring: { root?: string; path?: string; mode?: string } }>('/api/git/diff', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.query.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const target = req.query.path
    if (typeof target !== 'string' || target.trim() === '') {
      return reply.code(400).send({ success: false, error: '缺少 path' })
    }
    const mode = req.query.mode ?? 'worktree'
    if (mode !== 'worktree' && mode !== 'staged' && mode !== 'head') {
      return reply.code(400).send({ success: false, error: 'mode 必须是 worktree/staged/head' })
    }
    return send(reply, resolved.root, await diffOf(resolved.root.path, target, mode))
  })

  app.get<{ Querystring: { root?: string; limit?: string } }>('/api/git/log', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.query.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const limit = Number(req.query.limit ?? 30)
    return send(reply, resolved.root, await logOf(resolved.root.path, Number.isFinite(limit) ? limit : 30))
  })

  app.post<{ Body: RootBody & { paths?: unknown[] } }>('/api/git/stage', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    return send(reply, resolved.root, await stagePaths(resolved.root.path, req.body?.paths ?? []))
  })

  app.post<{ Body: RootBody & { paths?: unknown[] } }>('/api/git/unstage', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    return send(reply, resolved.root, await unstagePaths(resolved.root.path, req.body?.paths ?? []))
  })

  /** Throw away uncommitted changes for named files. `deleteNew` must be set for
   *  files git has never seen — removing them is not recoverable. */
  app.post<{ Body: RootBody & { paths?: unknown[]; deleteNew?: boolean } }>('/api/git/discard', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const { paths, deleteNew } = req.body ?? {}
    if (deleteNew !== undefined && typeof deleteNew !== 'boolean') {
      return reply.code(400).send({ success: false, error: 'deleteNew 必须是布尔值' })
    }
    return send(reply, resolved.root, await discardPaths(resolved.root.path, paths ?? [], deleteNew === true))
  })

  app.post<{ Body: RootBody & { message?: string; paths?: unknown[]; stageAll?: boolean } }>(
    '/api/git/commit',
    async (req, reply) => {
      const resolved = requireWorkspaceRoot(req.body?.root)
      if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
      const { message, paths, stageAll } = req.body ?? {}
      if (typeof message !== 'string') return reply.code(400).send({ success: false, error: '缺少提交信息' })
      if (stageAll !== undefined && typeof stageAll !== 'boolean') {
        return reply.code(400).send({ success: false, error: 'stageAll 必须是布尔值' })
      }
      if (paths !== undefined && !Array.isArray(paths)) {
        return reply.code(400).send({ success: false, error: 'paths 必须是数组' })
      }
      return send(
        reply,
        resolved.root,
        await commitStaged(resolved.root.path, message, {
          ...(paths ? { paths } : {}),
          ...(stageAll === true ? { stageAll: true } : {})
        })
      )
    }
  )

  /** Move the branch back one commit, keeping the changes on disk. */
  app.post<{ Body: RootBody & { mode?: string; force?: boolean } }>('/api/git/undo', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const mode = req.body?.mode ?? 'mixed'
    if (mode !== 'soft' && mode !== 'mixed') {
      return reply.code(400).send({ success: false, error: 'mode 必须是 soft 或 mixed' })
    }
    return send(reply, resolved.root, await undoLastCommit(resolved.root.path, mode as UndoMode, req.body?.force === true))
  })

  /** Inverse commit: the rollback that keeps published history intact. */
  app.post<{ Body: RootBody & { hash?: string } }>('/api/git/revert', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    return send(reply, resolved.root, await revertCommit(resolved.root.path, req.body?.hash ?? ''))
  })

  app.post<{ Body: RootBody }>('/api/git/revert-abort', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    return send(reply, resolved.root, await abortRevert(resolved.root.path))
  })
}
