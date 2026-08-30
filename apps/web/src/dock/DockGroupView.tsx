import { Fragment } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { chromeSurface, color, metric } from '../design/tokens'
import Badge from './Badge'
import Icon from './icons'
import { isPartId, partMeta, type PartId } from './parts'
import { dockToFrame, type DockEdge, type DockGroupNode } from './dockModel'
import type { DockApi } from './useDock'
import type { DockDragApi } from './useDockDrag'

/** A dock group: some parts, one tab strip, one body.
 *
 *  This single component is what used to be the primary sidebar, the bottom panel,
 *  the secondary sidebar and the editor area — four containers with four sets of
 *  chrome and four ideas about closing, resizing and tab order. Collapsing them
 *  into one is the whole design: whatever a user learns about one pane is now true
 *  of every pane.
 *
 *  The strip is always tabs, even when there is only one, so a lone part still has
 *  a name, a handle to drag it by and a place for its close button — but a single
 *  tab is drawn as a plain title instead of a raised pill, because there is nothing
 *  to choose between. One code path, two appearances, no mode.
 *
 *  Backgrounded parts unmount unless their metadata says otherwise. Every one of
 *  them keeps its real state on the server and replays it on mount; the two that
 *  cannot — the editor's unsaved buffers, the transcript's scroll — are the two
 *  marked `keepMounted`, and they hide with CSS instead. */

export interface DockGroupViewProps {
  group: DockGroupNode
  dock: DockApi
  drag: DockDragApi
  zoomed: boolean
  /** Set while this group's strip is the drop target: where the tab would land. */
  caret: { before: string | null } | null
  badges: Partial<Record<PartId, number>>
  alerts: Partial<Record<PartId, boolean>>
  renderPart: (part: PartId) => ReactNode
}

const KEY_TO_EDGE: Readonly<Record<string, DockEdge>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'top',
  ArrowDown: 'bottom'
}

export default function DockGroupView({
  group,
  dock,
  drag,
  zoomed,
  caret,
  badges,
  alerts,
  renderPart
}: DockGroupViewProps) {
  const solo = group.parts.length === 1
  const parts = group.parts.filter(isPartId)
  const activePart = parts.find((part) => part === group.active) ?? parts[0]

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLElement>, part: PartId): void => {
    // Alt+Shift+Arrow is the keyboard's version of the drag: send this part to an
    // edge of the frame. Same outcome, no pointer.
    if (event.altKey && event.shiftKey) {
      const edge = KEY_TO_EDGE[event.key]
      if (!edge) return
      const root = dock.current().root
      if (!root) return
      event.preventDefault()
      dock.setRoot(dockToFrame(root, part, edge))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      dock.revealPart(part)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      dock.closePart(part)
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const step = event.key === 'ArrowRight' ? 1 : -1
      const next = parts[(parts.indexOf(part) + step + parts.length) % parts.length]
      if (!next) return
      event.preventDefault()
      dock.revealPart(next)
    }
  }

  return (
    <section
      data-dock-group={group.id}
      aria-label={activePart ? partMeta(activePart).title : '面板'}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: color.surface,
        overflow: 'hidden'
      }}
    >
      <div
        data-dock-chrome
        style={{
          ...chromeSurface,
          height: metric.tabStripHeight,
          boxSizing: 'border-box',
          flex: 'none',
          display: 'flex',
          alignItems: 'stretch',
          borderBottom: `1px solid ${color.line}`
        }}
        onPointerDown={(event) => {
          // One rule: dragging a tab moves that part, dragging the strip moves
          // whichever part is in front. For a lone part those are the same thing,
          // which is what makes the strip feel like a window's title bar.
          if ((event.target as HTMLElement).closest('[data-dock-tab],button')) return
          if (activePart) drag.begin(event, activePart)
        }}
        onDoubleClick={(event) => {
          // The empty stretch of the strip behaves like a window title bar. A
          // double-click on a tab is two clicks on a tab, so exclude those.
          if (!(event.target as HTMLElement).closest('[data-dock-tab]')) dock.toggleZoom(group.id)
        }}
      >
        <div
          role="tablist"
          aria-label="面板标签"
          className="dock-tabs"
          style={{ display: 'flex', alignItems: 'stretch', flex: 1, minWidth: 0, padding: '0 2px' }}
        >
          {parts.map((part) => {
            const meta = partMeta(part)
            const active = part === group.active
            const count = badges[part] ?? 0
            return (
              <Fragment key={part}>
                {caret?.before === part && <span aria-hidden className="dock-caret" />}
                <span
                  role="tab"
                  data-dock-tab={part}
                  data-solo={solo ? 'true' : 'false'}
                  data-lifted={drag.partId === part ? 'true' : 'false'}
                  className="dock-tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  title={`${meta.title} — ${meta.hint}\n拖动到其它面板的边缘或标签栏即可重新停靠`}
                  onPointerDown={(event) => {
                    // Respond on press, not on click: the part comes forward the
                    // instant the finger lands, and the same press may become a drag.
                    dock.revealPart(part)
                    drag.begin(event, part)
                  }}
                  onKeyDown={(event) => onTabKeyDown(event, part)}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault()
                      dock.closePart(part)
                    }
                  }}
                >
                  <span className="dock-tab-label">{solo ? meta.title : meta.label}</span>
                  <Badge count={count} alert={alerts[part] === true} />
                  <button
                    type="button"
                    className="dock-tab-close"
                    aria-label={`关闭${meta.title}`}
                    title={`关闭${meta.title}(中键亦可)`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      dock.closePart(part)
                    }}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              </Fragment>
            )
          })}
          {caret?.before === null && <span aria-hidden className="dock-caret" />}
        </div>
        <button
          type="button"
          className="dock-chrome-action"
          aria-pressed={zoomed}
          aria-label={zoomed ? '还原面板大小' : '最大化面板'}
          title={zoomed ? '还原面板大小 · 双击标签栏亦可' : '最大化面板 · 双击标签栏亦可'}
          onClick={() => dock.toggleZoom(group.id)}
        >
          <Icon name={zoomed ? 'zoom-out' : 'zoom-in'} size={13} />
        </button>
      </div>

      <div
        data-dock-body
        style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, display: 'flex', overflow: 'hidden' }}
      >
        {parts.map((part) => {
          const active = part === group.active
          if (!active && !partMeta(part).keepMounted) return null
          return (
            <div
              key={part}
              style={{
                position: 'absolute',
                inset: 0,
                display: active ? 'flex' : 'none',
                flexDirection: 'column',
                minHeight: 0,
                minWidth: 0
              }}
            >
              {renderPart(part)}
            </div>
          )
        })}
      </div>
    </section>
  )
}
