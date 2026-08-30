import { Fragment, ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  DropZone,
  GridLayout,
  dropZoneFor,
  evenLayout,
  movePanel,
  normalizeLayout,
  parseStoredLayout,
  resizeColumns,
  resizeRows,
  serializeLayout
} from '../layout/gridModel'

/** Two-dimensional resizable panel grid: columns split left↔right, panels inside
 *  a column split top↕bottom. Both gutters drag with the pointer or the arrow
 *  keys, and a header can be dragged onto any edge of another panel to move it
 *  (left/right → new column, top/bottom → stack inside that column). The whole
 *  arrangement persists to localStorage. */

export interface GridPanelDef {
  id: string
  title: string
  content: ReactNode
  /** Minimum pixel width enforced while resizing columns. */
  minWidth?: number
  /** Minimum pixel height enforced while resizing rows. */
  minHeight?: number
  /** Initial column share when this panel is seen for the first time. */
  weight?: number
  closable?: boolean
  onClose?: () => void
  /** Render the title in monospace (file paths). */
  mono?: boolean
  /** Extra header controls, rendered before the close button. */
  actions?: ReactNode
}

const DEFAULT_MIN_WIDTH = 160
const DEFAULT_MIN_HEIGHT = 90
const GUTTER = 6
/** Weight step per arrow-key press, relative to the container total. */
const KEY_STEP = 0.04

const ZONE_STYLE: Record<DropZone, { left?: string | number; top?: string | number; right?: string | number; bottom?: string | number; width?: string; height?: string }> = {
  left: { left: 0, top: 0, bottom: 0, width: '50%' },
  right: { right: 0, top: 0, bottom: 0, width: '50%' },
  top: { left: 0, right: 0, top: 0, height: '50%' },
  bottom: { left: 0, right: 0, bottom: 0, height: '50%' }
}

interface DropTarget {
  id: string
  zone: DropZone
}

function loadLayout(storageKey: string): GridLayout {
  try {
    return parseStoredLayout(localStorage.getItem(storageKey))
  } catch {
    // Storage disabled (private mode) — start from the default arrangement.
    return { columns: [] }
  }
}

export default function PanelGrid({ storageKey, panels }: { storageKey: string; panels: GridPanelDef[] }) {
  const [stored, setStored] = useState<GridLayout>(() => loadLayout(storageKey))
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const byId = useMemo(() => new Map(panels.map((panel) => [panel.id, panel])), [panels])
  const defaultWeights = useMemo(
    () => Object.fromEntries(panels.map((panel) => [panel.id, panel.weight ?? 1])),
    [panels]
  )
  const layout = useMemo(
    () => normalizeLayout(stored, panels.map((panel) => panel.id), defaultWeights),
    [stored, panels, defaultWeights]
  )
  /** Live layout during a pointer drag, so persistence happens once on release. */
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const persist = useCallback(
    (next: GridLayout) => {
      setStored(next)
      try {
        localStorage.setItem(storageKey, serializeLayout(next))
      } catch {
        // Storage unavailable — the layout still applies for this session.
      }
    },
    [storageKey]
  )

  const minWidthOf = useCallback(
    (columnIndex: number) =>
      Math.max(
        ...layout.columns[columnIndex].rows.map((row) => byId.get(row.id)?.minWidth ?? DEFAULT_MIN_WIDTH),
        DEFAULT_MIN_WIDTH
      ),
    [byId, layout.columns]
  )

  const minHeightOf = useCallback(
    (columnIndex: number, rowIndex: number) =>
      byId.get(layout.columns[columnIndex].rows[rowIndex].id)?.minHeight ?? DEFAULT_MIN_HEIGHT,
    [byId, layout.columns]
  )

  /** Shared pointer-drag driver for both gutter orientations. `apply` receives
   *  the delta already converted from pixels into weight units. */
  const startDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    axis: 'x' | 'y',
    totalWeight: number,
    extent: number,
    apply: (deltaWeight: number) => GridLayout
  ): void => {
    if (extent <= 0 || totalWeight <= 0) return
    event.preventDefault()
    const gutter = event.currentTarget
    const start = axis === 'x' ? event.clientX : event.clientY
    gutter.setPointerCapture(event.pointerId)

    const onMove = (moveEvent: PointerEvent): void => {
      const moved = (axis === 'x' ? moveEvent.clientX : moveEvent.clientY) - start
      setStored(apply((moved / extent) * totalWeight))
    }
    const onUp = (): void => {
      gutter.removeEventListener('pointermove', onMove)
      gutter.removeEventListener('pointerup', onUp)
      gutter.removeEventListener('pointercancel', onUp)
      persist(layoutRef.current)
    }
    gutter.addEventListener('pointermove', onMove)
    gutter.addEventListener('pointerup', onUp)
    gutter.addEventListener('pointercancel', onUp)
  }

  const onColumnGutterDown = (index: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const width = containerRef.current?.clientWidth ?? 0
    const total = layout.columns.reduce((sum, column) => sum + column.weight, 0)
    const scale = total / Math.max(width, 1)
    startDrag(event, 'x', total, width, (delta) =>
      resizeColumns(layoutRef.current, index, delta, minWidthOf(index) * scale, minWidthOf(index + 1) * scale)
    )
  }

  const onRowGutterDown = (columnIndex: number, index: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const height = event.currentTarget.parentElement?.clientHeight ?? 0
    const total = layout.columns[columnIndex].rows.reduce((sum, row) => sum + row.weight, 0)
    const scale = total / Math.max(height, 1)
    startDrag(event, 'y', total, height, (delta) =>
      resizeRows(
        layoutRef.current,
        columnIndex,
        index,
        delta,
        minHeightOf(columnIndex, index) * scale,
        minHeightOf(columnIndex, index + 1) * scale
      )
    )
  }

  const onGutterKey = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    orientation: 'vertical' | 'horizontal',
    resize: (delta: number) => GridLayout
  ): void => {
    const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    if (event.key !== decrease && event.key !== increase) return
    event.preventDefault()
    persist(resize(event.key === increase ? KEY_STEP : -KEY_STEP))
  }

  const onPanelDrop = (targetId: string) => (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    const dragged = draggingId
    const zone = dropTarget?.id === targetId ? dropTarget.zone : null
    setDraggingId(null)
    setDropTarget(null)
    if (!dragged || !zone || dragged === targetId) return
    persist(movePanel(layoutRef.current, dragged, targetId, zone))
  }

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
      {layout.columns.map((column, columnIndex) => {
        const columnTotal = column.rows.reduce((sum, row) => sum + row.weight, 0)
        return (
          <Fragment key={`col-${columnIndex}`}>
            {columnIndex > 0 && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="调整左右宽度"
                tabIndex={0}
                title="拖动调整宽度 · 双击平分 · ←/→ 微调"
                onPointerDown={onColumnGutterDown(columnIndex - 1)}
                onDoubleClick={() => persist(evenLayout(layoutRef.current))}
                onKeyDown={(event) =>
                  onGutterKey(event, 'vertical', (delta) =>
                    resizeColumns(
                      layoutRef.current,
                      columnIndex - 1,
                      delta * layout.columns.reduce((sum, entry) => sum + entry.weight, 0)
                    )
                  )
                }
                style={{
                  width: GUTTER,
                  flex: 'none',
                  cursor: 'col-resize',
                  background: '#e8e8e8',
                  borderLeft: '1px solid #ddd',
                  borderRight: '1px solid #ddd',
                  touchAction: 'none',
                  boxSizing: 'border-box'
                }}
              />
            )}
            <div
              style={{
                flexGrow: column.weight,
                flexBasis: 0,
                minWidth: minWidthOf(columnIndex),
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                overflow: 'hidden'
              }}
            >
              {column.rows.map((row, rowIndex) => {
                const panel = byId.get(row.id)
                if (!panel) return null
                const active = dropTarget?.id === panel.id && draggingId !== null && draggingId !== panel.id
                return (
                  <Fragment key={panel.id}>
                    {rowIndex > 0 && (
                      <div
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="调整上下高度"
                        tabIndex={0}
                        title="拖动调整高度 · 双击平分 · ↑/↓ 微调"
                        onPointerDown={onRowGutterDown(columnIndex, rowIndex - 1)}
                        onDoubleClick={() => persist(evenLayout(layoutRef.current))}
                        onKeyDown={(event) =>
                          onGutterKey(event, 'horizontal', (delta) =>
                            resizeRows(layoutRef.current, columnIndex, rowIndex - 1, delta * columnTotal)
                          )
                        }
                        style={{
                          height: GUTTER,
                          flex: 'none',
                          cursor: 'row-resize',
                          background: '#e8e8e8',
                          borderTop: '1px solid #ddd',
                          borderBottom: '1px solid #ddd',
                          touchAction: 'none',
                          boxSizing: 'border-box'
                        }}
                      />
                    )}
                    <section
                      onDragOver={(event) => {
                        if (!draggingId || draggingId === panel.id) return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        const rect = event.currentTarget.getBoundingClientRect()
                        const zone = dropZoneFor(event.clientX, event.clientY, rect)
                        setDropTarget((prev) => (prev?.id === panel.id && prev.zone === zone ? prev : { id: panel.id, zone }))
                      }}
                      onDragLeave={() => setDropTarget((prev) => (prev?.id === panel.id ? null : prev))}
                      onDrop={onPanelDrop(panel.id)}
                      style={{
                        position: 'relative',
                        flexGrow: row.weight,
                        flexBasis: 0,
                        minHeight: panel.minHeight ?? DEFAULT_MIN_HEIGHT,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden'
                      }}
                    >
                      <header
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', panel.id)
                          setDraggingId(panel.id)
                        }}
                        onDragEnd={() => {
                          setDraggingId(null)
                          setDropTarget(null)
                        }}
                        title="拖动到其他面板的上/下/左/右边缘即可重新排布"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 8px',
                          background: '#f6f8fa',
                          borderBottom: '1px solid #e5e5e5',
                          cursor: 'grab',
                          userSelect: 'none',
                          fontSize: 12,
                          flex: 'none'
                        }}
                      >
                        <span style={{ color: '#adb5bd', fontSize: 10, letterSpacing: -1 }}>⋮⋮</span>
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontWeight: 600,
                            fontFamily: panel.mono ? 'ui-monospace, Consolas, monospace' : undefined
                          }}
                          title={panel.title}
                        >
                          {panel.title}
                        </span>
                        {panel.actions}
                        {panel.closable && (
                          <button
                            onClick={panel.onClose}
                            aria-label={`关闭 ${panel.title}`}
                            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, padding: '0 4px' }}
                          >
                            ✕
                          </button>
                        )}
                      </header>
                      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        {panel.content}
                      </div>
                      {active && dropTarget && (
                        <div
                          aria-hidden
                          style={{
                            position: 'absolute',
                            background: 'rgba(9,105,218,0.16)',
                            border: '2px dashed #0969da',
                            pointerEvents: 'none',
                            ...ZONE_STYLE[dropTarget.zone]
                          }}
                        />
                      )}
                    </section>
                  </Fragment>
                )
              })}
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
