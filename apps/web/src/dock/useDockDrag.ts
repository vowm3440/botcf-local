import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { edgeRect, frameEdgeAt, insertionBefore, zoneAt, type Rect, type TabRect } from './dockGeometry'
import { FRAME_SHARE, type DockEdge, type DockZone } from './dockModel'

/** Picking a part up and putting it somewhere else.
 *
 *  Written on Pointer Events rather than HTML5 drag-and-drop, for three reasons
 *  that all come down to the same thing — a drag is a continuous gesture, and the
 *  native API only reports it in fragments. Pointer events give the part 1:1
 *  tracking from the pixel the pointer moves, a ghost we draw ourselves (so it can
 *  keep the offset the user grabbed it by), and an Escape key that actually
 *  cancels.
 *
 *  Two performance decisions keep the gesture honest at 60fps:
 *
 *  - The ghost's position never enters React state. It is written straight to the
 *    node's transform, so following the pointer costs one style write per move
 *    instead of re-rendering a tree that contains a terminal and a file viewer.
 *  - Only the *target* is state, and only when it changes. Moving 40px inside the
 *    same drop zone renders nothing.
 *
 *  Geometry is snapshotted when the drag starts: the tree is not edited until the
 *  drop, so nothing under the pointer can move, and re-measuring on every event
 *  would only invite layout thrash. */

/** How far the pointer travels before a press becomes a drag. Tabs are clickable,
 *  so this has to be forgiving enough that a click never rearranges the workbench. */
const THRESHOLD_PX = 6
/** Grab offsets are clamped to roughly the ghost's own size. */
const GHOST_GRAB_LIMIT_X = 150
const GHOST_GRAB_LIMIT_Y = 26

export type DropTarget =
  | { readonly kind: 'frame'; readonly edge: DockEdge; readonly rect: Rect }
  | {
      readonly kind: 'group'
      readonly groupId: string
      readonly zone: DockZone
      /** For a drop on the tab strip: the tab to insert before, or null for last. */
      readonly before: string | null
      readonly rect: Rect
    }

export interface DockDragApi {
  /** The part currently being dragged, or null when nothing is. */
  partId: string | null
  target: DropTarget | null
  /** Start tracking a press. Call from `onPointerDown` on a tab or a title row. */
  begin: (event: ReactPointerEvent<HTMLElement>, partId: string) => void
  /** Attach to the drag ghost; the hook writes its transform directly. */
  ghostRef: MutableRefObject<HTMLDivElement | null>
}

interface GroupSnapshot {
  readonly id: string
  readonly rect: Rect
  /** The tab strip: a drop here means "make it a tab of this group". */
  readonly chrome: Rect | null
  readonly body: Rect
  readonly tabs: readonly TabRect[]
}

interface DragSnapshot {
  readonly frame: Rect
  readonly groups: readonly GroupSnapshot[]
}

interface PressState {
  readonly partId: string
  readonly startX: number
  readonly startY: number
  /** Where inside the ghost the user grabbed, so the card does not jump to centre. */
  readonly grabX: number
  readonly grabY: number
  dragging: boolean
  snapshot: DragSnapshot | null
  /** Latest pointer position: the ghost mounts a frame late and has to catch up. */
  lastX: number
  lastY: number
}

function toRect(element: HTMLElement): Rect {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height
}

function snapshotOf(frame: HTMLElement): DragSnapshot {
  const groups = Array.from(frame.querySelectorAll<HTMLElement>('[data-dock-group]')).map((element) => {
    const chrome = element.querySelector<HTMLElement>('[data-dock-chrome]')
    const body = element.querySelector<HTMLElement>('[data-dock-body]')
    const tabs = Array.from(element.querySelectorAll<HTMLElement>('[data-dock-tab]')).map((tab) => {
      const rect = toRect(tab)
      return { id: tab.dataset.dockTab ?? '', left: rect.left, width: rect.width }
    })
    return {
      id: element.dataset.dockGroup ?? '',
      rect: toRect(element),
      chrome: chrome ? toRect(chrome) : null,
      body: body ? toRect(body) : toRect(element),
      tabs
    }
  })
  return { frame: toRect(frame), groups }
}

/** Where the pointer is, resolved into a drop. `rect` is the highlight, in
 *  coordinates *relative to the frame*, so the indicator can be positioned without
 *  measuring anything during a render. */
function targetAt(snapshot: DragSnapshot, x: number, y: number): DropTarget | null {
  const local = (rect: Rect): Rect => ({
    ...rect,
    left: rect.left - snapshot.frame.left,
    top: rect.top - snapshot.frame.top
  })
  const edge = frameEdgeAt(x, y, snapshot.frame)
  if (edge) return { kind: 'frame', edge, rect: local(edgeRect(snapshot.frame, edge, FRAME_SHARE)) }
  const group = snapshot.groups.find((entry) => contains(entry.rect, x, y))
  if (!group) return null
  // The tab strip means "become a tab here", wherever in the strip it happens.
  if (group.chrome && contains(group.chrome, x, y)) {
    return {
      kind: 'group',
      groupId: group.id,
      zone: 'center',
      before: insertionBefore(group.tabs, x),
      rect: local(group.rect)
    }
  }
  const zone = zoneAt(x, y, group.body)
  return {
    kind: 'group',
    groupId: group.id,
    zone,
    before: null,
    rect: local(zone === 'center' ? group.rect : edgeRect(group.body, zone, 0.5))
  }
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'frame' && b.kind === 'frame') return a.edge === b.edge
  if (a.kind === 'group' && b.kind === 'group') {
    return a.groupId === b.groupId && a.zone === b.zone && a.before === b.before
  }
  return false
}

export function useDockDrag(
  frameRef: RefObject<HTMLElement>,
  onDrop: (partId: string, target: DropTarget) => void,
  /** Whether a drop would actually change anything. A highlight over a drop that
   *  does nothing is a promise the layout will not keep. */
  canDrop: (partId: string, target: DropTarget) => boolean
): DockDragApi {
  const [partId, setPartId] = useState<string | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const pressRef = useRef<PressState | null>(null)
  const targetRef = useRef<DropTarget | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  const canDropRef = useRef(canDrop)
  canDropRef.current = canDrop

  const finish = useCallback((committed: boolean): void => {
    const press = pressRef.current
    pressRef.current = null
    document.body.removeAttribute('data-dock-dragging')
    if (press?.dragging && committed && targetRef.current) {
      onDropRef.current(press.partId, targetRef.current)
    }
    targetRef.current = null
    setTarget(null)
    setPartId(null)
  }, [])

  const moveGhost = useCallback((x: number, y: number): void => {
    const press = pressRef.current
    const ghost = ghostRef.current
    if (!press || !ghost) return
    // No transition: a dragged thing is glued to the pointer, and an eased
    // follow is exactly the lag that makes a drag feel remote.
    ghost.style.transform = `translate3d(${Math.round(x - press.grabX)}px, ${Math.round(y - press.grabY)}px, 0)`
  }, [])

  // One window-level listener set for the whole gesture. The tab that started the
  // drag may re-render (or stop existing) mid-gesture, so the listeners cannot
  // live on it.
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const press = pressRef.current
      if (!press) return
      press.lastX = event.clientX
      press.lastY = event.clientY
      if (!press.dragging) {
        const travelled = Math.hypot(event.clientX - press.startX, event.clientY - press.startY)
        if (travelled < THRESHOLD_PX) return
        const frame = frameRef.current
        if (!frame) return
        press.dragging = true
        press.snapshot = snapshotOf(frame)
        document.body.setAttribute('data-dock-dragging', 'true')
        setPartId(press.partId)
      }
      event.preventDefault()
      moveGhost(event.clientX, event.clientY)
      if (!press.snapshot) return
      const found = targetAt(press.snapshot, event.clientX, event.clientY)
      const next = found && canDropRef.current(press.partId, found) ? found : null
      if (sameTarget(next, targetRef.current)) return
      targetRef.current = next
      setTarget(next)
    }
    const onUp = (): void => finish(true)
    const onCancel = (): void => finish(false)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && pressRef.current) {
        event.preventDefault()
        finish(false)
      }
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('keydown', onKey)
      document.body.removeAttribute('data-dock-dragging')
    }
  }, [finish, frameRef, moveGhost])

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>, part: string): void => {
    // Secondary buttons belong to the context menu, and a second finger during a
    // drag would fight the first one.
    if (event.button !== 0 || pressRef.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    pressRef.current = {
      partId: part,
      startX: event.clientX,
      startY: event.clientY,
      // Keep the offset the part was grabbed by, so the ghost does not jump to
      // centre. Clamped, because the handle can be a whole tab strip while the
      // ghost is a small card — past its size the offset stops meaning anything
      // and only pushes the ghost away from the pointer.
      grabX: Math.min(event.clientX - rect.left, GHOST_GRAB_LIMIT_X),
      grabY: Math.min(event.clientY - rect.top, GHOST_GRAB_LIMIT_Y),
      dragging: false,
      snapshot: null,
      lastX: event.clientX,
      lastY: event.clientY
    }
  }, [])

  // The ghost mounts one frame after the drag is recognized, so it has to be put
  // where the pointer already is instead of animating in from the origin.
  useEffect(() => {
    if (!partId) return
    const press = pressRef.current
    if (press) moveGhost(press.lastX, press.lastY)
  }, [moveGhost, partId])

  return { partId, target, begin, ghostRef }
}
