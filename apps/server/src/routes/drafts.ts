import { FastifyInstance, FastifyReply } from 'fastify'
import fs from 'node:fs'
import { config } from '../config.js'
import { deleteDraftRecovery, readDraftRecovery, writeDraftRecovery } from '../drafts/recovery.js'
import { locateWorkspacePath, type WorkspaceLocation } from '../workspace/locate.js'
import { formatWorkspacePath } from '../workspace/model.js'
import { getWorkspace } from '../workspace/store.js'

/** Draft recovery log for the editor (plan §4): the client spills an evicted
 *  dirty buffer here before dropping its in-memory row and fetches it back when
 *  the file reopens, so a page reload cannot lose an unsaved edit that the byte
 *  budget pushed out. Everything is keyed by the same qualified workspace path
 *  the file panel uses and stored under `<dataDir>/drafts/<rootId>/<relative>`,
 *  which keeps the entry inside the root it belongs to. */

interface DraftWire {
  success: true
  path: string
  root: { id: string; name: string }
  found: boolean
  draft: { content: string; baseMtimeMs: number; savedAt: number } | null
  /** Current on-disk file state, for the restore-time mtime compare. */
  mtimeMs: number | null
  exists: boolean
}

function replyForFailure(reply: FastifyReply, located: WorkspaceLocation): FastifyReply {
  if (located.status === 'missing') {
    return reply.code(404).send({ success: false, error: '文件或目录不存在(可能已被移动或删除)' })
  }
  return reply.code(400).send({ success: false, error: '路径越出工作区目录' })
}

function locatedFile(reply: FastifyReply, workspacePath: string): Extract<WorkspaceLocation, { status: 'ok' }> | null {
  const workspace = getWorkspace()
  if (workspace.roots.length === 0) {
    reply.code(409).send({ success: false, error: '未设置工作目录' })
    return null
  }
  const located = locateWorkspacePath(workspace, workspacePath)
  if (located.status === 'workspace') {
    reply.code(400).send({ success: false, error: '不是文件' })
    return null
  }
  if (located.status !== 'ok') {
    replyForFailure(reply, located)
    return null
  }
  return located
}

function currentFileState(target: string): { mtimeMs: number | null; exists: boolean } {
  try {
    const stat = fs.statSync(target)
    return { mtimeMs: stat.isFile() ? stat.mtimeMs : null, exists: stat.isFile() }
  } catch {
    return { mtimeMs: null, exists: false }
  }
}

function draftPayload(located: Extract<WorkspaceLocation, { status: 'ok' }>): DraftWire {
  const entry = readDraftRecovery(config.dataDir, located.root.id, located.relative)
  const disk = currentFileState(located.target)
  return {
    success: true,
    path: formatWorkspacePath(located.root.name, located.relative),
    root: { id: located.root.id, name: located.root.name },
    found: entry !== null,
    draft: entry ? { content: entry.content, baseMtimeMs: entry.baseMtimeMs, savedAt: entry.savedAt } : null,
    mtimeMs: disk.mtimeMs,
    exists: disk.exists
  }
}

export function registerDraftRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>('/api/drafts', async (req, reply) => {
    const located = locatedFile(reply, (req.query.path ?? '').trim())
    if (!located) return reply
    return draftPayload(located)
  })

  app.post<{ Body: { path?: string; content?: string; baseMtimeMs?: number } }>(
    '/api/drafts',
    // JSON escaping of a content-cap-sized draft keeps headroom like the file save.
    { bodyLimit: 4 * 1024 * 1024 },
    async (req, reply) => {
      const { path: requested, content, baseMtimeMs } = req.body ?? {}
      if (typeof requested !== 'string' || requested.trim() === '') {
        return reply.code(400).send({ success: false, error: '缺少 path' })
      }
      if (typeof content !== 'string') {
        return reply.code(400).send({ success: false, error: '缺少 content' })
      }
      if (typeof baseMtimeMs !== 'number') {
        return reply.code(400).send({ success: false, error: '缺少 baseMtimeMs' })
      }
      const located = locatedFile(reply, requested)
      if (!located) return reply
      try {
        writeDraftRecovery(config.dataDir, located.root.id, located.relative, content, baseMtimeMs)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('字节上限')) return reply.code(413).send({ success: false, error: message })
        return reply.code(400).send({ success: false, error: message })
      }
      return draftPayload(located)
    }
  )

  app.post<{ Body: { path?: string } }>('/api/drafts/delete', async (req, reply) => {
    const { path: requested } = req.body ?? {}
    if (typeof requested !== 'string' || requested.trim() === '') {
      return reply.code(400).send({ success: false, error: '缺少 path' })
    }
    const located = locatedFile(reply, requested)
    if (!located) return reply
    const removed = deleteDraftRecovery(config.dataDir, located.root.id, located.relative)
    return { removed, ...draftPayload(located) }
  })
}