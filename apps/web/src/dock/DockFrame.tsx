import { useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { color, text } from '../design/tokens'
import DockNodeView from './DockNodeView'
import { partMetaOrNull, type PartId } from './parts'
import {
  dockBesideGroup,
  dockIntoGroup,
  dockToFrame,
  findGroup,
  openParts,
  type DockNode
} from './dockModel'
import type { DockApi } from './useDock'
import { useDockDrag, type DropTarget } from './useDockDrag'

/** The frame: the tree, the drop indicator, and the thing being dragged.
 *
 *  All three live here rather than in the groups because a drag is one gesture
 *  across the whole window. One indicator element travels between drop targets —
 *  from the right half of the editor to the left edge of the frame — instead of ten
 *  indicators fading in and out, which is what lets the highlight *glide* and read
 *  as a single answer to "where will this land".
 *
 *  The indicator is always the size of the actual outcome: half a pane for a split,
 *  the whole pane for a new tab, `FRAME_SHARE` of the frame for a frame edge. A
 *  highlight that does not match the result is a lie the layout tells once. */

export interface DockFrameProps {
  dock: DockApi
  badges: Partial<Record<PartId, number>>
  alerts: Partial<Record<PartId, boolean>>
  renderPart: (part: PartId) => ReactNode
  /** Shown when the user has closed every last part. */
  empty: ReactNode
}

export default function DockFrame({ dock, badges, alerts, renderPart, empty }: DockFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const { root, zoomed } = dock.arrangement

  const onDrop = useCallback(
    (partId: string, target: DropTarget): void => {
      const current = dock.current().root
      if (!current) return
      const next: DockNode =
        target.kind === 'frame'
          ? dockToFrame(current, partId, target.edge)
          : target.zone === 'center'
            ? dockIntoGroup(current, partId, target.groupId, target.before)
            : dockBesideGroup(current, partId, target.groupId, target.zone)
      dock.setRoot(next)
    },
    [dock]
  )

  /** Refuse the drops that would change nothing, so the indicator never appears
   *  over a gesture that is about to be ignored. */
  const canDrop = useCallback(
    (partId: string, target: DropTarget): boolean => {
      const current = dock.current().root
      if (!current) return false
      if (target.kind === 'frame') return openParts(current).length > 1
      const entry = findGroup(current, target.groupId)
      if (!entry) return false
      if (target.zone === 'center') return true
      return !(entry.group.parts.length === 1 && entry.group.parts[0] === partId)
    },
    [dock]
  )

  const drag = useDockDrag(frameRef, onDrop, canDrop)
  const target = drag.target

  return (
    <div
      ref={frameRef}
      style={{
        position: 'relative',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        background: color.sunken,
        overflow: 'hidden'
      }}
    >
      {root ? (
        <DockNodeView
          node={root}
          path={[]}
          context={{ dock, drag, zoomedId: zoomed, badges, alerts, renderPart }}
        />
      ) : (
        empty
      )}

      {target && (
        <div
          aria-hidden
          className="dock-indicator"
          data-tab={target.kind === 'group' && target.zone === 'center' ? 'true' : 'false'}
          style={{
            left: target.rect.left,
            top: target.rect.top,
            width: target.rect.width,
            height: target.rect.height
          }}
        />
      )}

      {drag.partId && (
        <div ref={drag.ghostRef} aria-hidden className="dock-ghost">
          {partMetaOrNull(drag.partId)?.title ?? drag.partId}
        </div>
      )}
    </div>
  )
}

/** The workbench with nothing open. Not a blank canvas: the one place a user can
 *  end up with no visible affordance is also the one place that has to say where
 *  the affordances are. */
export function DockEmptyState() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        color: color.ink3,
        textAlign: 'center',
        padding: 24
      }}
    >
      <div style={{ ...text.title, color: color.ink2 }}>面板都关掉了</div>
      <div style={{ ...text.body, maxWidth: 360 }}>
        从最左侧的活动栏里点一个图标就能把它放回来;拖动标签到任意面板的边缘可以重新分栏。
      </div>
    </div>
  )
}
