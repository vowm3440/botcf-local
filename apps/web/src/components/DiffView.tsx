import { useMemo } from 'react'

/** VS Code style inline diff: old/new line-number gutters, full-line
 *  backgrounds, and darker word-level emphasis on changed characters.
 *  Falls back to a plain unified rendering when no @@ hunk headers exist. */

interface DiffViewProps {
  diff: string
}

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

interface Segment {
  text: string
  emphasized: boolean
}

interface DiffRow {
  kind: LineKind
  text: string
  oldNo?: number
  newNo?: number
  segments?: Segment[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Split a del/add line pair into common prefix, changed middle, common suffix. */
function charSegments(delText: string, addText: string): [Segment[], Segment[]] {
  let prefix = 0
  while (prefix < delText.length && prefix < addText.length && delText[prefix] === addText[prefix]) prefix++
  let suffix = 0
  while (
    suffix < delText.length - prefix &&
    suffix < addText.length - prefix &&
    delText[delText.length - 1 - suffix] === addText[addText.length - 1 - suffix]
  ) suffix++
  const split = (text: string): Segment[] => {
    const segments: Segment[] = []
    if (prefix > 0) segments.push({ text: text.slice(0, prefix), emphasized: false })
    const middle = text.slice(prefix, text.length - suffix)
    if (middle) segments.push({ text: middle, emphasized: true })
    if (suffix > 0) segments.push({ text: text.slice(text.length - suffix), emphasized: false })
    return segments
  }
  return [split(delText), split(addText)]
}

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
      const [delSegments, addSegments] = charSegments(rows[i + k].text, rows[delEnd + k].text)
      rows[i + k] = { ...rows[i + k], segments: delSegments }
      rows[delEnd + k] = { ...rows[delEnd + k], segments: addSegments }
    }
    i = addEnd
  }

  return { rows, numbered: rows.some((row) => row.oldNo !== undefined || row.newNo !== undefined) }
}

const ROW_BACKGROUNDS: Record<LineKind, string> = {
  add: '#e6ffec',
  del: '#ffebe9',
  hunk: '#ddf4ff',
  meta: '#f6f8fa',
  ctx: '#ffffff'
}

const EMPHASIS_BACKGROUNDS: Record<'add' | 'del', string> = {
  add: '#abf2bc',
  del: '#ffc1c0'
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
    color: '#8c959f',
    userSelect: 'none' as const
  }

  return (
    <div style={{ overflowX: 'auto', background: '#fff', border: '1px solid #eee', borderRadius: 6, fontSize: 12, lineHeight: 1.6, fontFamily: MONO }}>
      {rows.map((row, index) => {
        if (row.kind === 'hunk' || row.kind === 'meta') {
          return (
            <div key={index} style={{ whiteSpace: 'pre', padding: '0 8px', background: ROW_BACKGROUNDS[row.kind], color: row.kind === 'hunk' ? '#0969da' : '#57606a', fontWeight: 600 }}>
              {row.text || ' '}
            </div>
          )
        }
        const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''
        const markerColor = row.kind === 'add' ? '#1a7f37' : row.kind === 'del' ? '#cf222e' : '#8c959f'
        return (
          <div key={index} style={{ display: 'flex', whiteSpace: 'pre', background: ROW_BACKGROUNDS[row.kind], color: '#24292f' }}>
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
