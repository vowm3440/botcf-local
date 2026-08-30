import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, diffColor } from './diffPalette'
import type { EditRegion } from './editRegions'
import { buildInlineRows, type InlineRow } from './inlineRows'
import { wordSegments } from './wordDiff'
import { color, font, text } from '../design/tokens'

/** The file, with what the assistant removed put back where it was taken from.
 *
 *  This is the view a unified diff cannot be. A diff hunk gives three lines of
 *  context, which is enough to review a change and not enough to read it: you cannot
 *  see which function it is in, or that the branch above it already handles the case.
 *  Here the surrounding code is the page, the additions are highlighted in place, and
 *  the deleted lines sit in the gap they were taken from — so the change is read in
 *  the file rather than beside it.
 *
 *  Unchanged stretches collapse to one row by default and the whole file expands on
 *  demand, up to a size past which rendering every line stops being worth it. Row
 *  building is pure and lives in inlineRows.ts; this only paints.
 *
 *  Only the rows near the viewport are in the DOM. Every row is exactly one
 *  CODE_LINE_HEIGHT tall — gaps included — so the scroll height is arithmetic and the
 *  window is an index range, no measurement involved. Expanded, this view used to put
 *  up to FULL_VIEW_LIMIT rows of three elements each in the document; the same change
 *  on the editor's line-number column returned ~41 MiB of renderer, and these rows are
 *  three real elements apiece against that column's single text node.
 *
 *  Caveat worth keeping honest: the perf gate cannot check this. Its fixture has no
 *  diff, so 「内联」 is unreachable there and the saving above is reasoned from the
 *  gutter measurement rather than measured here. See docs/perf-gate-2026-08-28.md §9. */

export interface InlineDiffHandle {
  /** Scroll a 1-based line of the current file into the middle. */
  revealLine: (line: number) => void
}

export interface InlineDiffViewProps {
  /** Current file content, already split. */
  lines: readonly string[]
  /** Anchored, merged regions from `trackEdits`. */
  regions: readonly EditRegion[]
  full: boolean
  onToggleFull: () => void
}

/** Past this, showing every line means tens of thousands of rows for a handful of
 *  changes; the collapsed view is the only honest option and the toggle says so. */
export const FULL_VIEW_LIMIT = 4000

/** Rows kept in the DOM either side of the viewport. Enough that scrolling and paging
 *  do not re-render, small enough that the window stays a window. */
const OVERSCAN = 60

interface RowWindow {
  start: number
  end: number
}

const ROW: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  height: CODE_LINE_HEIGHT,
  display: 'flex',
  whiteSpace: 'pre',
  fontSize: CODE_FONT_SIZE,
  lineHeight: `${CODE_LINE_HEIGHT}px`,
  fontFamily: font.mono,
  color: diffColor.ink
}

const NUMBER_COLUMN: CSSProperties = {
  flex: 'none',
  textAlign: 'right',
  paddingRight: '0.75ch',
  color: diffColor.gutterInk,
  userSelect: 'none'
}

const MARKER_COLUMN: CSSProperties = {
  width: '2ch',
  flex: 'none',
  textAlign: 'center',
  userSelect: 'none',
  fontWeight: 600
}

function rowBackground(kind: InlineRow['kind']): string {
  if (kind === 'added') return diffColor.addRow
  if (kind === 'removed') return diffColor.delRow
  return diffColor.ctxRow
}

const InlineDiffView = forwardRef<InlineDiffHandle, InlineDiffViewProps>(function InlineDiffView(
  { lines, regions, full, onToggleFull },
  ref
) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const canExpand = lines.length <= FULL_VIEW_LIMIT
  const expanded = full && canExpand
  const rows = useMemo(() => buildInlineRows(lines, regions, { full: expanded }), [lines, regions, expanded])
  const digits = Math.max(2, String(Math.max(lines.length, 1)).length)

  /** Row index for a 1-based file line. Built with the rows because `revealLine` can
   *  no longer look the row up in the DOM — the row it wants is usually not there. */
  const indexOfLine = useMemo(() => {
    const index = new Map<number, number>()
    rows.forEach((row, position) => {
      if (row.line !== null && !index.has(row.line)) index.set(row.line, position)
    })
    return index
  }, [rows])

  // Named `rowWindow`, not `window`: shadowing the global inside a browser component
  // is a trap waiting for the next person who reaches for `window.getSelection()`.
  const [rowWindow, setRowWindow] = useState<RowWindow>({ start: 0, end: 0 })
  const windowRef = useRef(rowWindow)

  /** Recompute the rendered range from the scroll position, and only re-render when
   *  the viewport has left it. Every row is one CODE_LINE_HEIGHT tall, so this is
   *  arithmetic — nothing is measured and nothing forces layout. */
  const syncWindow = useCallback(() => {
    const container = scrollerRef.current
    if (!container) return
    const first = Math.floor(container.scrollTop / CODE_LINE_HEIGHT)
    const last = Math.ceil((container.scrollTop + container.clientHeight) / CODE_LINE_HEIGHT)
    const current = windowRef.current
    if (first >= current.start && last <= current.end && current.end > current.start) return
    const next = {
      start: Math.max(0, first - OVERSCAN),
      end: Math.min(rowsRef.current, last + OVERSCAN)
    }
    windowRef.current = next
    setRowWindow(next)
  }, [])

  /** The row count `syncWindow` clamps against, without making it depend on a render. */
  const rowsRef = useRef(rows.length)
  rowsRef.current = rows.length

  // A new row list is a new scroll space: the window has to be recomputed against it
  // before anything is painted, or the first frame shows rows from the old one.
  useLayoutEffect(() => {
    windowRef.current = { start: 0, end: 0 }
    syncWindow()
  }, [rows, syncWindow])

  const visible = rows.slice(rowWindow.start, rowWindow.end)

  useImperativeHandle(
    ref,
    () => ({
      revealLine: (line) => {
        const container = scrollerRef.current
        if (!container) return
        const position = indexOfLine.get(line)
        if (position !== undefined) {
          container.scrollTop = Math.max(0, position * CODE_LINE_HEIGHT - container.clientHeight / 2)
          syncWindow()
          return
        }
        // A deletion past the last line has no row of its own; its removed lines are
        // the tail of the list.
        if (line > lines.length) {
          container.scrollTop = container.scrollHeight
          syncWindow()
        }
      }
    }),
    [indexOfLine, lines.length, syncWindow]
  )

  const renderText = useCallback((row: InlineRow) => {
    if (row.paired === undefined || (row.kind !== 'added' && row.kind !== 'removed')) return row.text || ' '
    const [removed, added] = wordSegments(row.kind === 'removed' ? row.text : row.paired, row.kind === 'removed' ? row.paired : row.text)
    const segments = row.kind === 'removed' ? removed : added
    if (segments.length === 0) return row.text || ' '
    const emphasis = row.kind === 'removed' ? diffColor.delEmphasis : diffColor.addEmphasis
    return segments.map((segment, index) => (
      <span key={index} style={segment.emphasized ? { background: emphasis, borderRadius: 2 } : undefined}>
        {segment.text}
      </span>
    ))
  }, [])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...text.micro, color: color.ink3 }}>
        <span>
          {regions.length === 0 ? '这一版磁盘内容里已经找不到 AI 的改动' : `${regions.length} 处改动 · 删除的行显示在原位`}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onToggleFull}
          disabled={!canExpand}
          title={canExpand ? '在整份文件与仅改动附近之间切换' : `文件超过 ${FULL_VIEW_LIMIT} 行,只显示改动附近`}
          style={{
            ...text.micro,
            padding: '1px 8px',
            border: `1px solid ${color.lineStrong}`,
            borderRadius: 4,
            background: color.surface,
            color: canExpand ? color.ink2 : color.ink3,
            cursor: canExpand ? 'pointer' : 'default'
          }}
        >
          {expanded ? '仅显示改动附近' : '显示全文'}
        </button>
      </div>
      <div
        ref={scrollerRef}
        onScroll={syncWindow}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          background: color.surface,
          border: `1px solid ${color.line}`,
          borderRadius: 6
        }}
      >
        {/* The full scroll space, whether or not its rows are in the DOM. */}
        <div style={{ position: 'relative', height: rows.length * CODE_LINE_HEIGHT }}>
          {visible.map((row, offset) => {
            const index = rowWindow.start + offset
            const top = index * CODE_LINE_HEIGHT
            if (row.kind === 'gap') {
              return (
                <div
                  key={`gap-${index}`}
                  onClick={canExpand ? onToggleFull : undefined}
                  title={canExpand ? '点击显示全文' : undefined}
                  style={{
                    ...ROW,
                    top,
                    background: diffColor.metaRow,
                    color: diffColor.metaInk,
                    cursor: canExpand ? 'pointer' : 'default',
                    borderTop: `1px solid ${color.line}`,
                    borderBottom: `1px solid ${color.line}`,
                    boxSizing: 'border-box'
                  }}
                >
                  <span style={{ ...NUMBER_COLUMN, width: `${digits}ch` }}>⋯</span>
                  <span style={MARKER_COLUMN} />
                  <span>{row.skipped} 行未改动</span>
                </div>
              )
            }
            const marker = row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''
            return (
              <div
                key={`${row.kind}-${index}`}
                data-line={row.line ?? undefined}
                style={{ ...ROW, top, background: rowBackground(row.kind) }}
              >
                <span style={{ ...NUMBER_COLUMN, width: `${digits}ch` }}>{row.line ?? ''}</span>
                <span
                  style={{
                    ...MARKER_COLUMN,
                    color: row.kind === 'added' ? diffColor.addInk : row.kind === 'removed' ? diffColor.delInk : diffColor.gutterInk
                  }}
                >
                  {marker}
                </span>
                <span style={{ flex: 'none', paddingRight: 8 }}>{renderText(row)}</span>
              </div>
            )
          })}
        </div>
        {rows.length === 0 && (
          <div style={{ ...text.micro, color: color.ink3, padding: 10 }}>没有可显示的行。</div>
        )}
      </div>
    </div>
  )
})

export default InlineDiffView
