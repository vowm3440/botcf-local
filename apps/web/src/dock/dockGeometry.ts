import type { DockEdge, DockZone } from './dockModel'

/** Where a drag lands, in geometry only.
 *
 *  Kept apart from both the tree and the components because it is the part most
 *  easily got wrong and the easiest to test: a drop that picks 'left' when the
 *  pointer is plainly in the middle is the kind of bug that makes a dock feel
 *  unpredictable, and it needs no browser to catch.
 *
 *  Edge bands are measured in pixels, not in fractions of the pane. A bottom panel
 *  is short and wide; a fractional band would put a 300px "left edge" on it and
 *  make dropping a tab into it nearly impossible. */

export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Band as a share of the pane, clamped so it works from 120px to 2000px wide. */
const EDGE_RATIO = 0.24
const EDGE_MIN = 18
const EDGE_MAX = 110

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function bandOf(extent: number): number {
  // A pane too small for two bands would have no centre left at all; give the
  // centre half of it and let the bands share the rest. Never zero: a pane that
  // has not been laid out yet would divide by it.
  return Math.max(1, Math.min(clamp(extent * EDGE_RATIO, EDGE_MIN, EDGE_MAX), extent / 4))
}

/** Which zone of a pane the pointer sits in: an edge when it is inside that edge's
 *  band, the centre otherwise. Distances are normalized by their own band so the
 *  nearest *band* wins rather than the nearest edge in raw pixels. */
export function zoneAt(x: number, y: number, rect: Rect): DockZone {
  const bandX = bandOf(rect.width)
  const bandY = bandOf(rect.height)
  const candidates: ReadonlyArray<readonly [DockEdge, number]> = [
    ['left', (x - rect.left) / bandX],
    ['right', (rect.left + rect.width - x) / bandX],
    ['top', (y - rect.top) / bandY],
    ['bottom', (rect.top + rect.height - y) / bandY]
  ]
  const nearest = candidates.reduce((best, entry) => (entry[1] < best[1] ? entry : best))
  return nearest[1] > 1 ? 'center' : nearest[0]
}

/** Slice `share` of a rectangle off one edge — the area a drop would occupy, and
 *  therefore exactly what the indicator draws. Half of a pane for a split beside a
 *  group; `FRAME_SHARE` of the frame for a drop on the frame's own edge. */
export function edgeRect(rect: Rect, edge: DockEdge, share: number): Rect {
  const ratio = clamp(share, 0.05, 0.95)
  switch (edge) {
    case 'left':
      return { ...rect, width: rect.width * ratio }
    case 'right':
      return { ...rect, left: rect.left + rect.width * (1 - ratio), width: rect.width * ratio }
    case 'top':
      return { ...rect, height: rect.height * ratio }
    case 'bottom':
      return { ...rect, top: rect.top + rect.height * (1 - ratio), height: rect.height * ratio }
  }
}

/** The frame's own edges, checked before any group: dragging a part to the far
 *  right of the window should make a right-hand column, whatever happens to be
 *  under the pointer at the time. */
export function frameEdgeAt(x: number, y: number, rect: Rect, band = 34): DockEdge | null {
  const right = rect.left + rect.width
  const bottom = rect.top + rect.height
  if (x < rect.left || x > right || y < rect.top || y > bottom) return null
  const distances: ReadonlyArray<readonly [DockEdge, number]> = [
    ['left', x - rect.left],
    ['right', right - x],
    ['top', y - rect.top],
    ['bottom', bottom - y]
  ]
  const nearest = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))
  return nearest[1] <= band ? nearest[0] : null
}

export interface TabRect {
  readonly id: string
  readonly left: number
  readonly width: number
}

/** Which tab a dragged tab should be inserted before, or null for "at the end".
 *  Midpoints, so the caret flips exactly when the pointer passes a tab's centre. */
export function insertionBefore(tabs: readonly TabRect[], x: number): string | null {
  for (const tab of tabs) {
    if (x < tab.left + tab.width / 2) return tab.id
  }
  return null
}
