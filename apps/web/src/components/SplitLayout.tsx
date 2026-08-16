import { Fragment, ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react'

/** Horizontal split-pane layout: panels separated by draggable gutters
 *  (resize handles), headers draggable to rearrange panel order. Order and
 *  widths persist to localStorage so the arrangement survives reloads. */

export interface SplitPanelDef {
  id: string
  title: string
  content: ReactNode
  /** Minimum pixel width enforced while resizing. */
  minWidth?: number
  /** Initial proportional weight when nothing is stored yet. */
  weight?: number
  closable?: boolean
  onClose?: () => void
  /** Render the title in monospace (file paths). */
  mono?: boolean
}

interface StoredLayout {
  order: string[]
  weights: Record<string, number>
}

const DEFAULT_MIN_WIDTH = 120

function loadLayout(storageKey: string): StoredLayout {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredLayout>
      if (Array.isArray(parsed.order) && parsed.weights && typeof parsed.weights === 'object') {
        const weights: Record<string, number> = {}
        for (const [id, value] of Object.entries(parsed.weights)) {
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) weights[id] = value
        }
        return {
          order: parsed.order.filter((id): id is string => typeof id === 'string'),
          weights
        }
      }
    }
  } catch {
    // Corrupt or unavailable storage — fall back to defaults.
  }
  return { order: [], weights: {} }
}

export default function SplitLayout({ storageKey, panels }: { storageKey: string; panels: SplitPanelDef[] }) {
  const [layout, setLayout] = useState<StoredLayout>(() => loadLayout(storageKey))
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const persist = useCallback((next: StoredLayout) => {
    setLayout(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // Storage unavailable — the layout still applies for this session.
    }
  }, [storageKey])

  /** Stored order first, then any panels never seen before. */
  const visible = useMemo(() => {
    const byId = new Map(panels.map((panel) => [panel.id, panel]))
    const ordered = layout.order.filter((id) => byId.has(id)).map((id) => byId.get(id)!)
    const rest = panels.filter((panel) => !layout.order.includes(panel.id))
    return [...ordered, ...rest]
  }, [panels, layout.order])

  const weightOf = useCallback(
    (panel: SplitPanelDef) => layout.weights[panel.id] ?? panel.weight ?? 1,
    [layout.weights]
  )

  const onGutterPointerDown = (leftIndex: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    const left = visible[leftIndex]
    const right = visible[leftIndex + 1]
    if (!container || !left || !right) return
    event.preventDefault()
    const totalWeight = visible.reduce((sum, panel) => sum + weightOf(panel), 0)
    const containerWidth = container.getBoundingClientRect().width
    if (containerWidth <= 0 || totalWeight <= 0) return
    const startX = event.clientX
    const startLeft = weightOf(left)
    const startRight = weightOf(right)
    const minLeft = ((left.minWidth ?? DEFAULT_MIN_WIDTH) / containerWidth) * totalWeight
    const minRight = ((right.minWidth ?? DEFAULT_MIN_WIDTH) / containerWidth) * totalWeight
    const gutter = event.currentTarget
    gutter.setPointerCapture(event.pointerId)

    const onMove = (moveEvent: PointerEvent) => {
      const deltaWeight = ((moveEvent.clientX - startX) / containerWidth) * totalWeight
      let nextLeft = startLeft + deltaWeight
      let nextRight = startRight - deltaWeight
      if (nextLeft < minLeft) {
        nextRight -= minLeft - nextLeft
        nextLeft = minLeft
      }
      if (nextRight < minRight) {
        nextLeft -= minRight - nextRight
        nextRight = minRight
      }
      setLayout((prev) => ({ ...prev, weights: { ...prev.weights, [left.id]: nextLeft, [right.id]: nextRight } }))
    }
    const onUp = () => {
      gutter.removeEventListener('pointermove', onMove)
      gutter.removeEventListener('pointerup', onUp)
      gutter.removeEventListener('pointercancel', onUp)
      persist(layoutRef.current)
    }
    gutter.addEventListener('pointermove', onMove)
    gutter.addEventListener('pointerup', onUp)
    gutter.addEventListener('pointercancel', onUp)
  }

  const onPanelDrop = (targetId: string) => (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    const dragged = draggingId
    setDraggingId(null)
    setDropTarget(null)
    if (!dragged || dragged === targetId) return
    const rect = event.currentTarget.getBoundingClientRect()
    const insertAfter = event.clientX > rect.left + rect.width / 2
    const ids = visible.map((panel) => panel.id).filter((id) => id !== dragged)
    const targetIndex = ids.indexOf(targetId)
    if (targetIndex < 0) return
    ids.splice(insertAfter ? targetIndex + 1 : targetIndex, 0, dragged)
    persist({ ...layoutRef.current, order: ids })
  }

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
      {visible.map((panel, index) => (
        <Fragment key={panel.id}>
          {index > 0 && (
            <div
              onPointerDown={onGutterPointerDown(index - 1)}
              title="拖动调整宽度"
              style={{ width: 6, flex: 'none', cursor: 'col-resize', background: '#e8e8e8', borderLeft: '1px solid #ddd', borderRight: '1px solid #ddd', touchAction: 'none', boxSizing: 'border-box' }}
            />
          )}
          <section
            onDragOver={(event) => {
              if (!draggingId || draggingId === panel.id) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropTarget(panel.id)
            }}
            onDragLeave={() => {
              setDropTarget((prev) => (prev === panel.id ? null : prev))
            }}
            onDrop={onPanelDrop(panel.id)}
            style={{
              flexGrow: weightOf(panel),
              flexBasis: 0,
              minWidth: panel.minWidth ?? DEFAULT_MIN_WIDTH,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
              outline: draggingId && dropTarget === panel.id ? '2px dashed #0969da' : undefined,
              outlineOffset: -2
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
              title="拖动移动面板位置"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: '#f6f8fa', borderBottom: '1px solid #e5e5e5', cursor: 'grab', userSelect: 'none', fontSize: 12 }}
            >
              <span style={{ color: '#adb5bd', fontSize: 10, letterSpacing: -1 }}>⋮⋮</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, fontFamily: panel.mono ? 'ui-monospace, Consolas, monospace' : undefined }} title={panel.title}>
                {panel.title}
              </span>
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
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{panel.content}</div>
          </section>
        </Fragment>
      ))}
    </div>
  )
}
