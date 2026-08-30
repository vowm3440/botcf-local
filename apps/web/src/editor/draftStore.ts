/** In-memory draft cache for the editor panels.
 *
 *  Panels are remounted whenever the user rearranges the grid (a moved panel lands
 *  under a different DOM parent), and — since only the front tab keeps a mounted
 *  viewer — every tab switch too. Keeping unsaved buffers here, keyed by qualified
 *  workspace path, means none of that can silently discard an edit. Deliberately
 *  not persisted: a draft that outlived the page would fight the on-disk file the
 *  agent keeps rewriting.
 *
 *  This is also the single source of truth for *which* tabs are dirty. Deriving the
 *  ● marker from a mounted viewer's state cannot work once a hidden tab has no
 *  viewer; having the cache own it means the marker follows the buffer that
 *  actually exists. Subscribers are only notified when the *set* of drafted paths
 *  changes, never on every keystroke — typing must not re-render the workbench. */

export interface FileDraft {
  content: string
  /** mtime of the disk snapshot the draft was based on, for conflict detection. */
  baseMtimeMs: number
}

type Listener = () => void

let drafts: ReadonlyMap<string, FileDraft> = new Map()
let paths: ReadonlySet<string> = new Set()
const listeners = new Set<Listener>()

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
