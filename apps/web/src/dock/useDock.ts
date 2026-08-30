import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DOCK_STORAGE_KEY,
  closePart,
  defaultDock,
  loadDock,
  openPart,
  revealPart,
  serializeDock,
  toggleZoom,
  togglePart,
  withRoot,
  type DockArrangement
} from './dockLayout'
import type { DockNode } from './dockModel'
import type { PartId } from './parts'

/** React binding for the dock: the pure arrangement plus localStorage.
 *
 *  Two details matter here and nowhere else.
 *
 *  Persistence is debounced, because a sash drag produces a state update per
 *  pointer move and `localStorage.setItem` is synchronous. The layout applies on
 *  the frame it was asked for; only the write waits.
 *
 *  `current()` exists because pointer handlers outlive the render that installed
 *  them. A drag started three frames ago must read the tree as it is now, not the
 *  one it closed over — that is the difference between a sash that tracks the
 *  pointer and one that jumps. */

export interface DockApi {
  arrangement: DockArrangement
  /** The tree as of this instant, for handlers that outlive their render. */
  current: () => DockArrangement
  /** Replace the tree — used by the sash and by every drop. */
  setRoot: (root: DockNode | null) => void
  openPart: (part: PartId) => void
  revealPart: (part: PartId) => void
  togglePart: (part: PartId) => void
  closePart: (part: PartId) => void
  toggleZoom: (groupId: string) => void
  /** Back to the default arrangement, keeping the replaced one for one undo. */
  reset: () => void
  undoReset: () => void
  /** True while a reset can still be taken back. */
  resetUndoable: boolean
}

const PERSIST_DELAY_MS = 250

export function useDock(): DockApi {
  const [arrangement, setArrangement] = useState<DockArrangement>(loadDock)
  /** The arrangement a reset replaced. Undo instead of a confirmation dialog:
   *  rearranging a workbench is not destructive enough to interrupt someone for,
   *  but it is annoying enough to want back. */
  const [undoable, setUndoable] = useState<DockArrangement | null>(null)
  const liveRef = useRef(arrangement)
  liveRef.current = arrangement
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      try {
        localStorage.setItem(DOCK_STORAGE_KEY, serializeDock(arrangement))
      } catch {
        // Storage unavailable — the layout still applies for this session.
      }
    }, PERSIST_DELAY_MS)
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [arrangement])

  const update = useCallback((change: (previous: DockArrangement) => DockArrangement): void => {
    setUndoable(null)
    setArrangement((previous) => change(previous))
  }, [])

  return useMemo<DockApi>(
    () => ({
      arrangement,
      current: () => liveRef.current,
      setRoot: (root) => update((previous) => withRoot(previous, root)),
      openPart: (part) => update((previous) => openPart(previous, part)),
      revealPart: (part) => update((previous) => revealPart(previous, part)),
      togglePart: (part) => update((previous) => togglePart(previous, part)),
      closePart: (part) => update((previous) => closePart(previous, part)),
      toggleZoom: (groupId) => update((previous) => toggleZoom(previous, groupId)),
      reset: () => {
        setUndoable(liveRef.current)
        setArrangement(defaultDock())
      },
      undoReset: () => {
        if (!undoable) return
        setArrangement(undoable)
        setUndoable(null)
      },
      resetUndoable: undoable !== null
    }),
    [arrangement, undoable, update]
  )
}
