import { Fragment, useRef } from 'react'
import type { ReactNode } from 'react'
import DockGroupView from './DockGroupView'
import DockSash from './DockSash'
import { groupEntries, minExtent, type DockAxis, type DockNode, type DockPath, type DockSplitNode } from './dockModel'
import { partMetaOrNull, type PartId } from './parts'
import type { DockApi } from './useDock'
import type { DockDragApi } from './useDockDrag'

/** The tree, rendered.
 *
 *  A split is a flex container; a child's `weight` is its `flex-grow` with a zero
 *  basis, which is why proportions survive a window resize without a single
 *  measurement or a resize observer. Between children sits a sash, and that is the
 *  entire renderer — everything else recurses.
 *
 *  Two details that are not obvious:
 *
 *  Zoom hides siblings with `display: none` rather than rendering a different tree.
 *  A part that is mounted stays mounted, so zooming the terminal and coming back
 *  does not cost the editor its scroll position or the transcript its place.
 *
 *  React keys are derived from the group ids in a subtree, not from its position.
 *  Rearranging panes therefore moves DOM instead of recreating it, which is the
 *  difference between dragging a terminal to the right and restarting it. */

export interface DockContext {
  dock: DockApi
  drag: DockDragApi
  zoomedId: string | null
  badges: Partial<Record<PartId, number>>
  alerts: Partial<Record<PartId, boolean>>
  renderPart: (part: PartId) => ReactNode
}

export interface DockNodeViewProps {
  node: DockNode
  path: DockPath
  context: DockContext
}

/** Tab strips do not shrink, so a pane's minimum height includes its chrome. */
const TAB_STRIP_PX = 30
const SASH_PX = 1

function minOfPart(axis: DockAxis): (partId: string) => number {
  return (partId) => {
    const meta = partMetaOrNull(partId)
    if (!meta) return 0
    return axis === 'x' ? meta.minWidth : meta.minHeight + TAB_STRIP_PX
  }
}

function keyOf(node: DockNode): string {
  if (node.kind === 'group') return node.id
  return `${node.axis}:${groupEntries(node)[0]?.group.id ?? 'empty'}`
}

function containsGroup(node: DockNode, groupId: string): boolean {
  return groupEntries(node).some((entry) => entry.group.id === groupId)
}

export default function DockNodeView({ node, path, context }: DockNodeViewProps) {
  if (node.kind === 'group') {
    const target = context.drag.target
    const caret =
      target?.kind === 'group' && target.groupId === node.id && target.zone === 'center'
        ? { before: target.before }
        : null
    return (
      <DockGroupView
        group={node}
        dock={context.dock}
        drag={context.drag}
        zoomed={context.zoomedId === node.id}
        caret={caret}
        badges={context.badges}
        alerts={context.alerts}
        renderPart={context.renderPart}
      />
    )
  }
  return <DockSplitView node={node} path={path} context={context} />
}

function DockSplitView({ node, path, context }: { node: DockSplitNode; path: DockPath; context: DockContext }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { axis, children } = node
  const zoomedId = context.zoomedId
  const zoomIndex = zoomedId ? children.findIndex((child) => containsGroup(child, zoomedId)) : -1
  const minOf = minOfPart(axis)
  /** Extent available to the panes: the container minus the seams between them. */
  const measure = (): number => {
    const element = containerRef.current
    if (!element) return 0
    const extent = axis === 'x' ? element.clientWidth : element.clientHeight
    return extent - (children.length - 1) * SASH_PX
  }

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: axis === 'x' ? 'row' : 'column',
        overflow: 'hidden'
      }}
    >
      {children.map((child, index) => {
        const hidden = zoomIndex >= 0 && index !== zoomIndex
        return (
          <Fragment key={keyOf(child)}>
            {index > 0 && zoomIndex < 0 && (
              <DockSash
                dock={context.dock}
                axis={axis}
                path={path}
                index={index - 1}
                minLeading={minExtent(children[index - 1], axis, minOf)}
                minTrailing={minExtent(child, axis, minOf)}
                measure={measure}
                value={children[index - 1].weight}
                label={axis === 'x' ? '调整左右宽度' : '调整上下高度'}
              />
            )}
            <div
              style={{
                flexGrow: zoomIndex >= 0 ? 1 : child.weight,
                flexBasis: 0,
                minWidth: 0,
                minHeight: 0,
                display: hidden ? 'none' : 'flex',
                overflow: 'hidden'
              }}
            >
              <DockNodeView node={child} path={[...path, index]} context={context} />
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
