import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  TabsState,
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  cycleTab,
  moveTab,
  openTab,
  parseStoredTabs,
  serializeTabs
} from './tabsModel'
import { clearDraft, draftPaths, draftedPaths, evictStaleDrafts, subscribeDrafts } from './draftStore'
import { pruneViewerStates } from './viewerState'

/** React binding for the editor tab strip: the pure model plus localStorage
 *  persistence (tab order *and* the active tab) and dirty-tab bookkeeping read
 *  straight from the draft cache.
 *
 *  The ● marker follows the cached buffer rather than a mounted viewer, because
 *  the viewer behind a tab is unmounted: a hidden tab has no component to ask, and
 *  its unsaved edits are exactly what the marker is about. */

export interface OpenTabsApi {
  tabs: TabsState
  /** Paths with unsaved edits — protected from eviction and from focus stealing. */
  dirtyPaths: ReadonlySet<string>
  activeIsDirty: boolean
  open: (path: string, options?: { activate?: boolean }) => void
  close: (path: string) => void
  closeOthers: (path: string) => void
  closeAll: () => void
  activate: (path: string) => void
  cycle: (offset: number) => void
  move: (path: string, beforePath: string | null) => void
}

function loadTabs(storageKey: string): TabsState {
  try {
    return parseStoredTabs(localStorage.getItem(storageKey))
  } catch {
    return { paths: [], activePath: null }
  }
}

/** Closing a tab drops everything remembered for it, in two steps with different
 *  timing. The unsaved buffer goes now: the ● marker and the eviction keep-set both
 *  read the draft cache, and neither may see a tab that is already gone. The view
 *  state it was left in is swept afterwards, against the committed tab set — the
 *  viewer writes that one while unmounting, so a delete here would simply be undone
 *  (see pruneViewerStates). A reopened file starts fresh either way. */
function forgetTab(path: string): void {
  clearDraft(path)
}

export function useOpenTabs(storageKey: string): OpenTabsApi {
  const [tabs, setTabs] = useState<TabsState>(() => loadTabs(storageKey))
  const dirtyPaths = useSyncExternalStore(subscribeDrafts, draftedPaths, draftedPaths)
  /** Current tabs for the stable callbacks below, which must not close over a
   *  stale render while keeping the state updaters side-effect free. */
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, serializeTabs(tabs))
    } catch {
      // Storage unavailable — tabs still work for this session.
    }
  }, [storageKey, tabs])

  // Whichever way tabs went away — close, 关闭其他, 全部关闭 — their viewers have
  // already run their unmount cleanup by the time this effect does, so the committed
  // tab set is the last word on which view states are still worth keeping.
  useEffect(() => {
    pruneViewerStates(tabs.paths)
    // Byte budget for stale drafts: anything not open in a tab is spilled into
    // the bounded doc cache (and restores on reopen) before its row is dropped,
    // so retained dirty bytes stay flat regardless of edit volume.
    evictStaleDrafts(tabs.paths)
  }, [tabs])

  const open = useCallback((path: string, options?: { activate?: boolean }) => {
    setTabs((prev) => {
      const next = openTab(prev, path, { keep: draftPaths() })
      // Background open: keep the current tab in front (the user is editing it).
      return options?.activate === false && prev.activePath ? { ...next, activePath: prev.activePath } : next
    })
  }, [])

  const close = useCallback((path: string) => {
    forgetTab(path)
    setTabs((prev) => closeTab(prev, path))
  }, [])

  const closeOthers = useCallback((path: string) => {
    for (const candidate of tabsRef.current.paths) {
      if (candidate !== path) forgetTab(candidate)
    }
    setTabs((prev) => closeOtherTabs(prev, path))
  }, [])

  const closeAll = useCallback(() => {
    for (const candidate of tabsRef.current.paths) forgetTab(candidate)
    setTabs(closeAllTabs())
  }, [])

  const activate = useCallback((path: string) => {
    setTabs((prev) => activateTab(prev, path))
  }, [])

  const cycle = useCallback((offset: number) => {
    setTabs((prev) => cycleTab(prev, offset))
  }, [])

  const move = useCallback((path: string, beforePath: string | null) => {
    setTabs((prev) => moveTab(prev, path, beforePath))
  }, [])

  const activeIsDirty = useMemo(
    () => Boolean(tabs.activePath && dirtyPaths.has(tabs.activePath)),
    [dirtyPaths, tabs.activePath]
  )

  return { tabs, dirtyPaths, activeIsDirty, open, close, closeOthers, closeAll, activate, cycle, move }
}
