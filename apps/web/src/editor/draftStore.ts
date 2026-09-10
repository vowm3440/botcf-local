/** In-memory draft cache for the editor panels.
 *
 *  Panels are remounted whenever the user rearranges the grid (a moved panel lands
 *  under a different DOM parent), and — since only the front tab keeps a mounted
 *  viewer — every tab switch too. Keeping unsaved buffers here, keyed by qualified
 *  workspace path, means none of that can silently discard an edit. Deliberately
 *  not persisted across page loads: a draft that outlived the page would fight the
 *  on-disk file the agent keeps rewriting.
 *
 *  This is also the single source of truth for *which* tabs are dirty. Deriving the
 *  ● marker from a mounted viewer's state cannot work once a hidden tab has no
 *  viewer; having the cache own it means the marker follows the buffer that
 *  actually exists. Subscribers are only notified when the *set* of drafted paths
 *  changes, never on every keystroke — typing must not re-render the workbench.
 *
 *  Memory budget (plan §4): drafts that belong to an *open* tab are protected (the
 *  tab strip refuses to evict dirty tabs), so the only way draft bytes grow past
 *  the budget is stale buffers for tabs that were already closed without a save.
 *  Those are the ones eviction may touch: their content is first spilled into the
 *  byte-bounded DocCache (the "recovery log"), then the draft row is dropped.
 *  Reopening the file restores the spill; the mtime compare on save runs through
 *  the existing draftPolicy conflict path either way. */

import { DocCache, DEFAULT_DOC_CACHE_BYTES } from './docCache'

export interface FileDraft {
  content: string
  /** mtime of the disk snapshot the draft was based on, for conflict detection. */
  baseMtimeMs: number
}

/** A recovery-log entry as the disk-backed adapter returns it: the draft plus
 *  the on-disk mtime at fetch time, so the restore notice can already say whether
 *  the disk file moved. Save-time conflict detection stays the server's mtime
 *  check either way. */
export interface RecoveredDraft extends FileDraft {
  diskMtimeMs: number | null
}

/** Optional disk-backed recovery log (plan §4): the in-memory spill cannot
 *  survive a page reload, so the same payload is mirrored to the server's
 *  <dataDir>/drafts/<rootId>/ log. Absent (the default) keeps the pure in-memory
 *  behaviour; the app installs an adapter at startup. */
export interface DraftRecoveryAdapter {
  fetch(path: string): Promise<RecoveredDraft | null>
  persist(path: string, draft: FileDraft): Promise<void>
  drop(path: string): Promise<void>
}

let recoveryAdapter: DraftRecoveryAdapter | null = null

export function setDraftRecovery(adapter: DraftRecoveryAdapter | null): void {
  recoveryAdapter = adapter
}

/** Fetch a recovery-log entry from the disk-backed adapter, if one is installed.
 *  Failures read as "nothing to recover" — the file simply opens from disk. */
export async function restoreRecoveredDraft(path: string): Promise<RecoveredDraft | null> {
  if (!recoveryAdapter) return null
  try {
    return await recoveryAdapter.fetch(path)
  } catch {
    return null
  }
}

type Listener = () => void

/** Soft cap on retained dirty bytes. Open tabs are always protected, so this is
 *  a bound on *stale* drafts, not on the buffers the user is looking at. */
export const DRAFT_BYTE_BUDGET = 48 * 1024 * 1024

const SPILL_PREFIX = 'draft:'

let drafts: ReadonlyMap<string, FileDraft> = new Map()
let paths: ReadonlySet<string> = new Set()
const listeners = new Set<Listener>()
const spillCache = new DocCache(DEFAULT_DOC_CACHE_BYTES)

const utf8Encoder = new TextEncoder()

function contentBytes(content: string): number {
  return utf8Encoder.encode(content).length
}

function commit(next: ReadonlyMap<string, FileDraft>): void {
  const keysChanged = next.size !== paths.size || [...next.keys()].some((path) => !paths.has(path))
  drafts = next
  if (!keysChanged) return
  paths = new Set(next.keys())
  for (const listener of listeners) listener()
}

export function getDraft(path: string): FileDraft | undefined {
  return drafts.get(path)
}

export function setDraft(path: string, draft: FileDraft): void {
  const next = new Map(drafts)
  next.set(path, draft)
  commit(next)
}

export function clearDraft(path: string): void {
  if (!drafts.has(path)) return
  const next = new Map(drafts)
  next.delete(path)
  commit(next)
}

/** Stable snapshot of the drafted paths — the same reference until the set itself
 *  changes, which is what `useSyncExternalStore` requires. */
export function draftedPaths(): ReadonlySet<string> {
  return paths
}

export function draftPaths(): string[] {
  return [...paths]
}

export function subscribeDrafts(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Total UTF-8 bytes held by dirty buffers right now. */
export function draftBytes(): number {
  let total = 0
  for (const draft of drafts.values()) total += contentBytes(draft.content)
  return total
}

export function draftBytesFor(path: string): number {
  const draft = drafts.get(path)
  return draft ? contentBytes(draft.content) : 0
}

/** Spill one draft into the recovery cache and drop the in-memory row. Returns
 *  the path when a draft was actually evicted. */
function spillDraft(path: string): string | null {
  const draft = drafts.get(path)
  if (!draft) return null
  spillCache.set(SPILL_PREFIX + path, draft.baseMtimeMs, draft.content)
  // Mirror the eviction into the disk recovery log when one is installed. This is
  // best-effort and fire-and-forget: the in-memory spill above stays the source
  // of truth for this session, and a failed write must not break eviction.
  recoveryAdapter?.persist(path, draft).catch(() => undefined)
  const next = new Map(drafts)
  next.delete(path)
  commit(next)
  return path
}

/** Bring the retained dirty bytes back under `budget` by spilling the oldest
 *  drafts that are NOT among `openPaths` (open dirty tabs are protected: dropping
 *  them would silently lose an edit the user can see). Returns the paths spilled. */
export function evictStaleDrafts(openPaths: Iterable<string>, budget: number = DRAFT_BYTE_BUDGET): string[] {
  const open = new Set(openPaths)
  const spilled: string[] = []
  let total = 0
  for (const draft of drafts.values()) total += contentBytes(draft.content)
  if (total <= budget) return spilled
  // Map insertion order = oldest first, so the stale drafts evicted first are the
  // ones whose buffers have been around the longest.
  for (const path of [...drafts.keys()]) {
    if (total <= budget) break
    if (open.has(path)) continue
    const bytes = draftBytesFor(path)
    if (spillDraft(path)) {
      spilled.push(path)
      total -= bytes
    }
  }
  return spilled
}

/** Restore a previously spilled draft, if any. Callers compare the disk mtime
 *  through the normal conflict path before trusting the content. */
export function restoreSpilledDraft(path: string): FileDraft | undefined {
  const snapshot = spillCache.peek(SPILL_PREFIX + path)
  if (!snapshot) return undefined
  return { content: snapshot.content, baseMtimeMs: snapshot.mtimeMs }
}

/** Recovery-cache accounting for the UI/measurement (retained delta bytes stay
 *  flat past the budget — this is what the stage-4 acceptance checks). */
export function spillStats(): { bytes: number; entries: number; budgetBytes: number } {
  return spillCache.stats()
}

/** Drop the recovery snapshot for a path after it was saved/merged — both the
 *  in-memory one and the disk log, when one is installed. */
export function clearSpilledDraft(path: string): void {
  spillCache.delete(SPILL_PREFIX + path)
  recoveryAdapter?.drop(path).catch(() => undefined)
}

/** Test seam: reset module state. */
export function __resetDraftsForTests(): void {
  drafts = new Map()
  paths = new Set()
  spillCache.clear()
  recoveryAdapter = null
}
