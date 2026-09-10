import { FastifyInstance, FastifyReply } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { detectEncoding, encodeText } from '../textEncoding.js'
import { MAX_FILE_CONTENT_BYTES, readFileBounded } from '../textFile.js'
import { locateWorkspacePath, workspaceRootInfos, type WorkspaceLocation } from '../workspace/locate.js'
import { rootRuntime } from '../workspace/rootRuntime.js'
import { MAX_WORKSPACE_ROOTS, formatWorkspacePath, primaryRoot, type Workspace } from '../workspace/model.js'
import { getWorkspace } from '../workspace/store.js'

/** Workspace file access for the UI file panel: listing, bounded reads, and
 *  guarded editor saves. Every request names a *qualified workspace path*
 *  (`<rootName>/<relative>`, empty for the workspace itself) and is contained to
 *  the root it names via workspace/locate.ts — which layers root selection on top
 *  of fsContainment.ts (string containment plus a realpath re-check, so
 *  symlinks/junctions cannot escape a root either). */

// Containment helpers live in fsContainment.ts — the live-preview host needs
// them too. Bounded text reads live in textFile.ts, because the git panel needs
// them as well. Both are re-exported here, this module being their long-standing
// entry point.
export { locateInsideRoot, realpathInsideRoot, resolveInsideRoot } from '../fsContainment.js'
export type { LocateResult } from '../fsContainment.js'
export { MAX_FILE_CONTENT_BYTES, isProbablyBinary, readFileBounded } from '../textFile.js'
export type { BoundedFileContent } from '../textFile.js'

export interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtimeMs: number
}

export interface DirectoryListing {
  entries: FileEntry[]
  truncated: boolean
}

export const MAX_DIR_ENTRIES = 500

export type WriteRejection = 'not-file' | 'binary' | 'too-large' | 'conflict'

export type WriteFileResult =
  | { ok: true; size: number; mtimeMs: number }
  | { ok: false; code: WriteRejection; error: string }

/** Guarded save for the editor panel: only existing text files within the cap,
 *  with optional optimistic-concurrency via the mtime the viewer loaded. All
 *  rejections leave the on-disk file untouched. */
export function writeFileGuarded(
  file: string,
  content: string,
  baseMtimeMs?: number,
  cap = MAX_FILE_CONTENT_BYTES
): WriteFileResult {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return { ok: false, code: 'not-file', error: '文件不存在' }
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'not-file', error: '不是文件' }
  }
  if (stat.size > cap) {
    return { ok: false, code: 'too-large', error: '文件超过预览上限,编辑器持有的内容不完整,拒绝保存' }
  }
  // Sniff the whole file (its size is within the cap) so the save re-encodes in
  // the encoding and BOM the viewer decoded, instead of rewriting it as UTF-8.
  const detection = detectEncoding(fs.readFileSync(file))
  if (detection.encoding === 'binary') {
    return { ok: false, code: 'binary', error: '二进制文件不可编辑' }
  }
  const bytes = encodeText(content, detection)
  if (bytes.length > cap) {
    return { ok: false, code: 'too-large', error: `内容超过 ${cap} 字节上限` }
  }
  if (baseMtimeMs !== undefined && stat.mtimeMs !== baseMtimeMs) {
    return { ok: false, code: 'conflict', error: '文件已被其他进程修改,请重新加载后再保存' }
  }
  fs.writeFileSync(file, bytes)
  const after = fs.statSync(file)
  return { ok: true, size: after.size, mtimeMs: after.mtimeMs }
}

export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
}

/** Non-recursive listing with an entry cap; unreadable entries are skipped. */
export function listDirectory(dir: string, cap = MAX_DIR_ENTRIES): DirectoryListing {
  const collected: FileEntry[] = []
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    try {
      const stat = fs.statSync(path.join(dir, dirent.name))
      collected.push({
        name: dirent.name,
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs
      })
    } catch {
      // Broken symlink or permission error — skip the entry, keep the listing.
    }
  }
  const sorted = sortEntries(collected)
  return { entries: sorted.slice(0, cap), truncated: sorted.length > cap }
}

/** Virtual listing for the workspace itself: one directory entry per root, so the
 *  file tree can render several projects under a single browsable root. A root
 *  whose directory disappeared is still listed (mtime 0) — expanding it then
 *  reports "missing", which is what the user needs to see. */
export function listRootEntries(workspace: Workspace): DirectoryListing {
  const entries = workspace.roots.map((root) => {
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(root.path).mtimeMs
    } catch {
      // Missing root — keep it visible so it can be removed deliberately.
    }
    return { name: root.name, type: 'dir' as const, size: 0, mtimeMs }
  })
  return { entries, truncated: false }
}

/** Shared prefix for every file response: what the workspace currently holds, so
 *  the file panel can render its roots without a second request. */
function workspaceFields(workspace: Workspace): {
  workdir: string | null
  roots: ReturnType<typeof workspaceRootInfos>
  maxRoots: number
} {
  const runtimeById = new Map(rootRuntime.snapshot().roots.map((entry) => [entry.rootId, entry]))
  return {
    workdir: primaryRoot(workspace)?.path ?? null,
    roots: workspaceRootInfos(workspace, runtimeById),
    maxRoots: MAX_WORKSPACE_ROOTS
  }
}

function replyForFailure(reply: FastifyReply, located: WorkspaceLocation): FastifyReply {
  if (located.status === 'missing') {
    return reply.code(404).send({ success: false, error: '文件或目录不存在(可能已被移动或删除)' })
  }
  return reply.code(400).send({ success: false, error: '路径越出工作区目录' })
}

export function registerFileRoutes(app: FastifyInstance): void {
  /** Directory listing. An empty path lists the workspace roots themselves. */
  app.get<{ Querystring: { path?: string } }>('/api/omp/files', async (req, reply) => {
    const workspace = getWorkspace()
    const located = locateWorkspacePath(workspace, req.query.path ?? '')
    if (located.status === 'workspace') {
      return { success: true, ...workspaceFields(workspace), path: '', root: null, ...listRootEntries(workspace) }
    }
    if (located.status !== 'ok') return replyForFailure(reply, located)
    try {
      if (!fs.statSync(located.target).isDirectory()) {
        return reply.code(400).send({ success: false, error: '不是目录' })
      }
      const { entries, truncated } = listDirectory(located.target)
      return {
        success: true,
        ...workspaceFields(workspace),
        path: formatWorkspacePath(located.root.name, located.relative),
        root: { id: located.root.id, name: located.root.name },
        entries,
        truncated
      }
    } catch (err: unknown) {
      return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  /** Read-only file content for the editor panel, bounded and text-only. */
  app.get<{ Querystring: { path?: string } }>('/api/omp/file', async (req, reply) => {
    const workspace = getWorkspace()
    if (workspace.roots.length === 0) {
      return reply.code(409).send({ success: false, error: '未设置工作目录' })
    }
    const located = locateWorkspacePath(workspace, req.query.path ?? '')
    if (located.status === 'workspace') {
      return reply.code(400).send({ success: false, error: '不是文件' })
    }
    if (located.status !== 'ok') return replyForFailure(reply, located)
    try {
      const stat = fs.statSync(located.target)
      if (!stat.isFile()) {
        return reply.code(400).send({ success: false, error: '不是文件' })
      }
      const { content, size, truncated, binary, encoding } = readFileBounded(located.target)
      return {
        success: true,
        path: formatWorkspacePath(located.root.name, located.relative),
        root: { id: located.root.id, name: located.root.name },
        size,
        mtimeMs: stat.mtimeMs,
        content,
        truncated,
        binary,
        encoding
      }
    } catch (err: unknown) {
      return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  /** Editor save: existing text files only, capped, mtime-checked. The body
   *  limit leaves headroom for JSON escaping of a content-cap-sized file. */
  app.post<{ Body: { path?: string; content?: string; baseMtimeMs?: number } }>(
    '/api/omp/file',
    { bodyLimit: 4 * 1024 * 1024 },
    async (req, reply) => {
      const workspace = getWorkspace()
      if (workspace.roots.length === 0) {
        return reply.code(409).send({ success: false, error: '未设置工作目录' })
      }
      const { path: requested, content, baseMtimeMs } = req.body ?? {}
      if (!requested || typeof requested !== 'string') {
        return reply.code(400).send({ success: false, error: '缺少 path' })
      }
      if (typeof content !== 'string') {
        return reply.code(400).send({ success: false, error: '缺少 content' })
      }
      if (baseMtimeMs !== undefined && typeof baseMtimeMs !== 'number') {
        return reply.code(400).send({ success: false, error: 'baseMtimeMs 必须是数字' })
      }
      const located = locateWorkspacePath(workspace, requested)
      if (located.status === 'workspace') {
        return reply.code(400).send({ success: false, error: '不是文件' })
      }
      if (located.status !== 'ok') return replyForFailure(reply, located)
      try {
        const result = writeFileGuarded(located.target, content, baseMtimeMs)
        if (!result.ok) {
          return reply.code(result.code === 'conflict' ? 409 : 400).send({ success: false, code: result.code, error: result.error })
        }
        return {
          success: true,
          path: formatWorkspacePath(located.root.name, located.relative),
          root: { id: located.root.id, name: located.root.name },
          size: result.size,
          mtimeMs: result.mtimeMs
        }
      } catch (err: unknown) {
        return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
  )
}
