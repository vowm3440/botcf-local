import { useMemo } from 'react'
import { diffColor } from '../editor/diffPalette'
import { wordSegments, type WordSegment } from '../editor/wordDiff'

/** VS Code style inline diff: old/new line-number gutters, full-line
 *  backgrounds, and darker word-level emphasis on changed characters.
 *  Falls back to a plain unified rendering when no @@ hunk headers exist.
 *
 *  The raw report, deliberately: this view shows the diff text as the tool wrote
 *  it. Reading the same change *in* the file — with the surrounding code and the
 *  removed lines in place — is the inline view (editor/InlineDiffView.tsx), which
 *  needs the file content this one never loads. */

interface DiffViewProps {
  diff: string
}

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

interface DiffRow {
  kind: LineKind
  text: string
  oldNo?: number
  newNo?: number
  segments?: WordSegment[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function parseRows(diff: string): { rows: DiffRow[]; numbered: boolean } {
  const rows: DiffRow[] = []
  let oldNo: number | null = null
  let newNo: number | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      rows.push({ kind: 'meta', text: line })
      continue
    }
    const hunk = HUNK_HEADER.exec(line)
    if (hunk) {
      oldNo = parseInt(hunk[1], 10)
      newNo = parseInt(hunk[2], 10)
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newNo: newNo ?? undefined })
      if (newNo !== null) newNo++
      continue
    }
    if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo ?? undefined })
      if (oldNo !== null) oldNo++
      continue
    }
    rows.push({
      kind: 'ctx',
      text: oldNo !== null && line.startsWith(' ') ? line.slice(1) : line,
      oldNo: oldNo ?? undefined,
      newNo: newNo ?? undefined
    })
    if (oldNo !== null) oldNo++
    if (newNo !== null) newNo++
  }

  // Word-level pass: pair each run of deletions with the additions that follow.
  for (let i = 0; i < rows.length; ) {
    if (rows[i].kind !== 'del') {
      i++
      continue
    }
    let delEnd = i
    while (delEnd < rows.length && rows[delEnd].kind === 'del') delEnd++
    let addEnd = delEnd
    while (addEnd < rows.length && rows[addEnd].kind === 'add') addEnd++
    const pairs = Math.min(delEnd - i, addEnd - delEnd)
    for (let k = 0; k < pairs; k++) {
      const [delSegments, addSegments] = wordSegments(rows[i + k].text, rows[delEnd + k].text)
      rows[i + k] = { ...rows[i + k], segments: delSegments }
      rows[delEnd + k] = { ...rows[delEnd + k], segments: addSegments }
    }
    i = addEnd
  }

  // 无 @@ hunk 头的工具 diff:顺序推算旧/新行号,保证行号栏始终可用。
  if (!rows.some((row) => row.kind === 'hunk') && rows.some((row) => row.kind === 'add' || row.kind === 'del')) {
    let nextOld = 1
    let nextNew = 1
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row.kind === 'add') rows[i] = { ...row, newNo: nextNew++ }
      else if (row.kind === 'del') rows[i] = { ...row, oldNo: nextOld++ }
      else if (row.kind === 'ctx') rows[i] = { ...row, oldNo: nextOld++, newNo: nextNew++ }
    }
  }

  return { rows, numbered: rows.some((row) => row.oldNo !== undefined || row.newNo !== undefined) }
}

const ROW_BACKGROUNDS: Record<LineKind, string> = {
  add: diffColor.addRow,
  del: diffColor.delRow,
  hunk: diffColor.hunkRow,
  meta: diffColor.metaRow,
  ctx: diffColor.ctxRow
}

const EMPHASIS_BACKGROUNDS: Record<'add' | 'del', string> = {
  add: diffColor.addEmphasis,
  del: diffColor.delEmphasis
}

const MONO = 'ui-monospace, Consolas, monospace'

export default function DiffView({ diff }: DiffViewProps) {
  const { rows, numbered } = useMemo(() => parseRows(diff), [diff])
  const gutterCh = useMemo(() => {
    const maxNo = rows.reduce((max, row) => Math.max(max, row.oldNo ?? 0, row.newNo ?? 0), 0)
    return Math.max(2, String(maxNo).length)
  }, [rows])

  const gutterStyle = {
    width: `${gutterCh + 1}ch`,
    flex: 'none',
    textAlign: 'right' as const,
    paddingRight: '0.5ch',
    color: diffColor.gutterInk,
    userSelect: 'none' as const
  }

  return (
    <div style={{ overflowX: 'auto', background: diffColor.ctxRow, border: '1px solid #eee', borderRadius: 6, fontSize: 12, lineHeight: 1.6, fontFamily: MONO }}>
      {rows.map((row, index) => {
        if (row.kind === 'hunk' || row.kind === 'meta') {
          return (
            <div key={index} style={{ whiteSpace: 'pre', padding: '0 8px', background: ROW_BACKGROUNDS[row.kind], color: row.kind === 'hunk' ? diffColor.hunkInk : diffColor.metaInk, fontWeight: 600 }}>
              {row.text || ' '}
            </div>
          )
        }
        const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''
        const markerColor = row.kind === 'add' ? diffColor.addInk : row.kind === 'del' ? diffColor.delInk : diffColor.gutterInk
        return (
          <div key={index} style={{ display: 'flex', whiteSpace: 'pre', background: ROW_BACKGROUNDS[row.kind], color: diffColor.ink }}>
            {numbered && <span style={gutterStyle}>{row.oldNo ?? ''}</span>}
            {numbered && <span style={gutterStyle}>{row.newNo ?? ''}</span>}
            <span style={{ width: '2ch', flex: 'none', textAlign: 'center', userSelect: 'none', color: markerColor, fontWeight: 600 }}>{marker}</span>
            <span style={{ flex: 'none', paddingRight: 8 }}>
              {row.segments
                ? row.segments.map((segment, si) => (
                    <span key={si} style={segment.emphasized && (row.kind === 'add' || row.kind === 'del') ? { background: EMPHASIS_BACKGROUNDS[row.kind], borderRadius: 2 } : undefined}>
                      {segment.text}
                    </span>
                  ))
                : row.text || ' '}
            </span>
          </div>
        )
      })}
    </div>
  )
}
