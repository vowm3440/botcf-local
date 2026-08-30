import { useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { evenSplit, nodeAt, resizeSplit, type DockAxis, type DockNode, type DockPath } from './dockModel'
import type { DockApi } from './useDock'

/** The seam between two panes.
 *
 *  One pixel of hairline, seven pixels of grab area. The visual weight is what the
 *  layout needs — a chunky grey bar is a shape the eye has to keep dismissing —
 *  and the hit area is what the hand needs. Both live in dock.css, because the
 *  states that matter (hover, focus, mid-drag) cannot be written inline.
 *
 *  The drag recomputes from the tree as it was when the gesture started, applying
 *  the *total* distance travelled rather than accumulating per-event deltas. Two
 *  panes at their minimum can then be pushed back open by dragging the other way,
 *  and nothing drifts over a long gesture.
 *
 *  Arrow keys move it in 24px steps and double-click evens the split, because a
 *  pointer-only affordance is no affordance for anyone not holding a pointer. */

export interface DockSashProps {
  dock: DockApi
  /** 'x' is a vertical seam between columns; 'y' a horizontal one between rows. */
  axis: DockAxis
  /** The split this seam belongs to, and which pair of children it moves. */
  path: DockPath
  index: number
  /** Pixel minimums of the panes on either side, resolved from their parts. */
  minLeading: number
  minTrailing: number
  /** The container's extent along the axis. Read at drag start, never at render. */
  measure: () => number
  /** The leading pane's share, 0–1 — the separator's value for assistive tech. */
  value: number
  label: string
}

const KEY_STEP_PX = 24

export default function DockSash({
  dock,
  axis,
  path,
  index,
  minLeading,
  minTrailing,
  measure,
  value,
  label
}: DockSashProps) {
  const [dragging, setDragging] = useState(false)

  /** Weight per pixel for the split this sash belongs to, plus its tree snapshot. */
  const begin = (): { root: DockNode; scale: number } | null => {
    const root = dock.current().root
    if (!root) return null
    const split = nodeAt(root, path)
    if (!split || split.kind !== 'split') return null
    const total = split.children.reduce((sum, child) => sum + child.weight, 0)
    const extent = Math.max(1, measure())
    return { root, scale: total / extent }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const started = begin()
    if (!started) return
    event.preventDefault()
    const handle = event.currentTarget
    const origin = axis === 'x' ? event.clientX : event.clientY
    const { root, scale } = started
    handle.setPointerCapture(event.pointerId)
    setDragging(true)

    const onMove = (moveEvent: PointerEvent): void => {
      const travelled = (axis === 'x' ? moveEvent.clientX : moveEvent.clientY) - origin
      dock.setRoot(
        resizeSplit(root, path, index, travelled * scale, minLeading * scale, minTrailing * scale)
      )
    }
    const stop = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      setDragging(false)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
    const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
    if (event.key !== back && event.key !== forward) return
    const started = begin()
    if (!started) return
    event.preventDefault()
    const { root, scale } = started
    const step = (event.key === forward ? KEY_STEP_PX : -KEY_STEP_PX) * scale
    dock.setRoot(resizeSplit(root, path, index, step, minLeading * scale, minTrailing * scale))
  }

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      title={`${label} · 拖动或 ${axis === 'x' ? '←/→' : '↑/↓'} 调整 · 双击平分`}
      className="dock-sash"
      data-axis={axis}
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        const root = dock.current().root
        if (root) dock.setRoot(evenSplit(root, path))
      }}
    />
  )
}
