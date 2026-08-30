import type { ViewMode } from './ViewerHeader'

/** What an editor tab looked like when you last left it.
 *
 *  Only the front tab keeps a mounted viewer — a mounted one holds the whole file
 *  as a buffer, as a line array and as a textarea the browser lays out line by
 *  line, which for eight large files is hundreds of megabytes of renderer that
 *  nobody is looking at. Unmounting the rest is what makes that cost follow the
 *  file on screen instead of the number of open tabs.
 *
 *  What must not be lost with the viewer is the small part: which of the three
 *  views was open, where you were reading, and whether the inline diff was
 *  expanded. That is this file — a few numbers per path. The unsaved buffer is the
 *  other half and lives in draftStore.ts, because it has a different lifetime: it
 *  survives until saved or discarded, this only until the tab is closed. */

export interface ViewerState {
  mode: ViewMode
  /** 1-based line to bring back into view when the tab comes to the front again. */
  line: number
  /** The inline diff's 「整份文件」 toggle. */
  fullInline: boolean
}

let states: ReadonlyMap<string, ViewerState> = new Map()

export function getViewerState(path: string): ViewerState | undefined {
  return states.get(path)
}

export function rememberViewerState(path: string, state: ViewerState): void {
  const next = new Map(states)
  next.set(path, state)
  states = next
}

/** Keep only the tabs that are still open, and drop the rest.
 *
 *  Deleting a closed tab's entry at the moment it is closed does not hold: the
 *  viewer writes this state from its *unmount cleanup*, which for the tab in front
 *  runs after the click that closed it — so the delete happens first and the viewer
 *  puts the entry back on its way out, leaving state behind for a tab that no longer
 *  exists (and a reading position a reopened file would wrongly jump to). Sweeping
 *  against the committed tab set instead is order-independent: React runs a removed
 *  child's cleanup before the parent's effects for the same commit, so by the time
 *  the tab strip sweeps, every viewer that was going to write has written. */
export function pruneViewerStates(open: Iterable<string>): void {
  const keep = new Set(open)
  let stale = false
  for (const path of states.keys()) {
    if (!keep.has(path)) {
      stale = true
      break
    }
  }
  if (!stale) return
  const next = new Map<string, ViewerState>()
  for (const [path, state] of states) {
    if (keep.has(path)) next.set(path, state)
  }
  states = next
}
