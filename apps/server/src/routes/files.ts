import { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { ompClient } from '../omp/rpc.js'

/** Read-only workdir file listing for the UI file panel. Every request is
 *  contained to ompClient.workdir: string-level containment first, then a
 *  realpath re-check so symlinks/junctions cannot escape either. */

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

/** Pure string-level containment: resolve `requested` against `root`, refuse
 *  anything that escapes. Symlink escapes are caught by realpathInsideRoot. */
export function resolveInsideRoot(root: string, requested: string): string | null {
  const target = path.resolve(root, requested || '.')
  const rel = path.relative(root, target)
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return null
  return target
}

/** Containment check that collapses symlinks on both sides. Returns the real
 *  target path, or null when the path is missing or escapes the root. */
export function realpathInsideRoot(root: string, requested: string): string | null {
  const target = resolveInsideRoot(root, requested)
  if (!target) return null
  let realRoot: string
  let realTarget: string
  try {
    realRoot = fs.realpathSync.native(root)
    realTarget = fs.realpathSync.native(target)
  } catch {
    return null
  }
  const rel = path.relative(realRoot, realTarget)
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return null
  return realTarget
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

export function registerFileRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>('/api/omp/files', async (req, reply) => {
    const workdir = ompClient.workdir
    if (!workdir || !fs.existsSync(workdir)) {
      return { success: true, workdir: null, path: '', entries: [], truncated: false }
    }
    const target = realpathInsideRoot(workdir, req.query.path ?? '')
    if (!target) {
      return reply.code(400).send({ success: false, error: '路径不存在或越出工作目录' })
    }
    try {
      if (!fs.statSync(target).isDirectory()) {
        return reply.code(400).send({ success: false, error: '不是目录' })
      }
      const { entries, truncated } = listDirectory(target)
      const relPath = path.relative(fs.realpathSync.native(workdir), target).replace(/\\/g, '/')
      return { success: true, workdir, path: relPath, entries, truncated }
    } catch (err: unknown) {
      return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
