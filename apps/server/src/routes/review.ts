import { FastifyInstance } from 'fastify'
import {
  acceptPaths,
  clearReview,
  commitReviewed,
  reviewDiff,
  reviewOverview,
  revertPaths
} from '../review/service.js'

/** Agent-change review surface.
 *
 *  Every endpoint works on paths the *agent itself reported changing* — the review
 *  list is the only accepted vocabulary, so no request can reach a file the agent
 *  never touched. Accepting stages, reverting discards (and only deletes a newly
 *  created file when `deleteNew` is set), committing writes exactly the reviewed
 *  set and drops those files from the list. */

export function registerReviewRoutes(app: FastifyInstance): void {
  app.get('/api/review', async () => ({ success: true, ...(await reviewOverview()) }))

  app.get<{ Querystring: { path?: string } }>('/api/review/diff', async (req, reply) => {
    const target = req.query.path
    if (typeof target !== 'string' || target.trim() === '') {
      return reply.code(400).send({ success: false, error: '缺少 path' })
    }
    const result = await reviewDiff(target)
    if ('ok' in result && result.ok === false) {
      return reply.code(result.status).send({ success: false, error: result.error })
    }
    return { success: true, ...result }
  })

  app.post<{ Body: { paths?: unknown[] } }>('/api/review/accept', async (req, reply) => {
    const paths = req.body?.paths
    if (!Array.isArray(paths)) return reply.code(400).send({ success: false, error: 'paths 必须是数组' })
    const result = await acceptPaths(paths)
    if (!result.ok) return reply.code(result.status).send({ success: false, error: result.error })
    return { success: true, ...result, ...(await reviewOverview()) }
  })

  app.post<{ Body: { paths?: unknown[]; deleteNew?: boolean } }>('/api/review/revert', async (req, reply) => {
    const { paths, deleteNew } = req.body ?? {}
    if (!Array.isArray(paths)) return reply.code(400).send({ success: false, error: 'paths 必须是数组' })
    if (deleteNew !== undefined && typeof deleteNew !== 'boolean') {
      return reply.code(400).send({ success: false, error: 'deleteNew 必须是布尔值' })
    }
    const result = await revertPaths(paths, deleteNew === true)
    if (!result.ok) return reply.code(result.status).send({ success: false, error: result.error })
    return { success: true, ...result, ...(await reviewOverview()) }
  })

  app.post<{ Body: { root?: string; message?: string; paths?: unknown[] } }>('/api/review/commit', async (req, reply) => {
    const { root, message, paths } = req.body ?? {}
    if (root !== undefined && typeof root !== 'string') {
      return reply.code(400).send({ success: false, error: 'root 必须是字符串' })
    }
    if (message !== undefined && typeof message !== 'string') {
      return reply.code(400).send({ success: false, error: 'message 必须是字符串' })
    }
    if (paths !== undefined && !Array.isArray(paths)) {
      return reply.code(400).send({ success: false, error: 'paths 必须是数组' })
    }
    const result = await commitReviewed({
      ...(root ? { root } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(paths ? { paths } : {})
    })
    if (!result.ok) return reply.code(result.status).send({ success: false, error: result.error })
    return { success: true, ...result, ...(await reviewOverview()) }
  })

  /** Empty the review list without touching any file. */
  app.post('/api/review/clear', async () => {
    clearReview()
    return { success: true, ...(await reviewOverview()) }
  })
}
