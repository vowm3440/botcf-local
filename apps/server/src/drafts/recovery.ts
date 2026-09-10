import fs from 'node:fs'
import path from 'node:path'
import { MAX_FILE_CONTENT_BYTES } from '../textFile.js'

/** Disk-backed draft recovery log (plan §4): when the byte budget evicts a dirty
 *  buffer that belongs to a tab which is not open, the buffer is written here —
 *  under `<dataDir>/drafts/<rootId>/<relative path>` — before its in-memory row
 *  is dropped. Reopening the file fetches the entry and routes it through the
 *  same mtime conflict path as a draft that was never evicted, so a page reload
 *  or an app crash cannot silently take an unsaved edit with it.
 *
 *  Deliberately small and synchronous: this is a best-effort recovery log, not a
 *  database. A corrupt or unreadable entry reads as null (the file simply opens
 *  from disk); an entry that fails to write leaves the in-memory spill in place,
 *  which is the exact behaviour the budget row replaced, not a new failure mode. */

export interface DraftRecoveryEntry {
  content: string
  /** Disk mtime the draft was based on; save-time conflict check compares it. */
  baseMtimeMs: number
  savedAt: number
}

/** Draft content inherits the editor's file cap: nothing bigger can be edited,
 *  so nothing bigger can need recovery. */
export const MAX_DRAFT_RECOVERY_BYTES = MAX_FILE_CONTENT_BYTES

/** Root ids are caller-derived, so they are sanitised before touching a path. */
function safeSegment(value: string): string {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? 'root' : cleaned
}

export function rootDraftDir(dataDir: string, rootId: string): string {
  return path.join(dataDir, 'drafts', safeSegment(rootId))
}

function isInside(base: string, target: string): boolean {
  const relative = path.relative(base, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Resolve the entry file for a root-relative path, refusing anything that could
 *  leave that root's own drafts directory (parent segments, absolute paths). */
export function draftEntryFile(dataDir: string, rootId: string, relPath: string): string | null {
  const rel = (relPath ?? '').replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('/')) return null
  const segments = rel.split('/')
  if (segments.some((part) => part === '' || part === '.' || part === '..')) return null
  const dir = rootDraftDir(dataDir, rootId)
  const target = path.resolve(dir, ...segments)
  return isInside(dir, target) ? target : null
}

export function writeDraftRecovery(
  dataDir: string,
  rootId: string,
  relPath: string,
  content: string,
  baseMtimeMs: number
): void {
  if (typeof content !== 'string') throw new Error('草稿内容必须是字符串')
  if (Buffer.byteLength(content, 'utf8') > MAX_DRAFT_RECOVERY_BYTES) {
    throw new Error(`草稿超过 ${MAX_DRAFT_RECOVERY_BYTES} 字节上限`)
  }
  if (!Number.isFinite(baseMtimeMs)) throw new Error('baseMtimeMs 必须是数字')
  const file = draftEntryFile(dataDir, rootId, relPath)
  if (!file) throw new Error('草稿路径越出恢复目录')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Keep the exact mtime: the save-time conflict check compares it with the
  // server's stat.mtimeMs verbatim, and rounding here would fabricate conflicts.
  const entry: DraftRecoveryEntry = { content, baseMtimeMs, savedAt: Date.now() }
  // Temp + rename: a crash cannot leave a half-written JSON the reader trusts.
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8')
  fs.renameSync(tmp, file)
}

export function readDraftRecovery(dataDir: string, rootId: string, relPath: string): DraftRecoveryEntry | null {
  const file = draftEntryFile(dataDir, rootId, relPath)
  if (!file) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DraftRecoveryEntry>
    if (typeof parsed.content !== 'string' || typeof parsed.baseMtimeMs !== 'number') return null
    return { content: parsed.content, baseMtimeMs: parsed.baseMtimeMs, savedAt: parsed.savedAt ?? 0 }
  } catch {
    // Unreadable or corrupt — the editor falls back to the on-disk file.
    return null
  }
}

export function deleteDraftRecovery(dataDir: string, rootId: string, relPath: string): boolean {
  const file = draftEntryFile(dataDir, rootId, relPath)
  if (!file) return false
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** Forget every recovery entry of a root that just left the workspace. */
export function clearRootDraftRecovery(dataDir: string, rootId: string): number {
  const dir = rootDraftDir(dataDir, rootId)
  let removed = 0
  const walk = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.tmp')) {
        // A crashed write's leftover temp file; drop without counting it.
        try {
          fs.unlinkSync(full)
        } catch {
          // Best effort.
        }
      } else {
        try {
          fs.unlinkSync(full)
          removed += 1
        } catch {
          // A file another process is removing can stay behind; harmless.
        }
      }
    }
  }
  walk(dir)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Already gone.
  }
  return removed
}