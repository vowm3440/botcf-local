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
export const MAX_FILE_CONTENT_BYTES = 1024 * 1024

/** NUL byte in the leading sample means the file is not renderable text. */
export function isProbablyBinary(sample: Buffer): boolean {
  const limit = Math.min(sample.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (sample[i] === 0) return true
  }
  return false
}

export interface BoundedFileContent {
  content: string
  size: number
  truncated: boolean
  binary: boolean
}

/** Read at most `cap` bytes so the viewer never loads an unbounded file. */
export function readFileBounded(file: string, cap = MAX_FILE_CONTENT_BYTES): BoundedFileContent {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const buffer = Buffer.allocUnsafe(Math.min(size, cap))
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const sample = buffer.subarray(0, read)
    const binary = isProbablyBinary(sample)
    return { content: binary ? '' : sample.toString('utf8'), size, truncated: size > cap, binary }
  } finally {
    fs.closeSync(fd)
  }
}

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

  /** Read-only file content for the editor panel, bounded and text-only. */
  app.get<{ Querystring: { path?: string } }>('/api/omp/file', async (req, reply) => {
    const workdir = ompClient.workdir
    if (!workdir || !fs.existsSync(workdir)) {
      return reply.code(409).send({ success: false, error: '未设置工作目录' })
    }
    const target = realpathInsideRoot(workdir, req.query.path ?? '')
    if (!target) {
      return reply.code(400).send({ success: false, error: '路径不存在或越出工作目录' })
    }
    try {
      const stat = fs.statSync(target)
      if (!stat.isFile()) {
        return reply.code(400).send({ success: false, error: '不是文件' })
      }
      const { content, size, truncated, binary } = readFileBounded(target)
      const relPath = path.relative(fs.realpathSync.native(workdir), target).replace(/\\/g, '/')
      return { success: true, path: relPath, size, mtimeMs: stat.mtimeMs, content, truncated, binary }
    } catch (err: unknown) {
      return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
