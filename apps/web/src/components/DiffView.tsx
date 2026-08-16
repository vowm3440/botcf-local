import type { CSSProperties } from 'react'

/** Unified-diff renderer with VS Code / GitHub style line highlighting:
 *  added lines get a green background, removed lines red, hunk headers blue. */

interface DiffViewProps {
  diff: string
}

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

function classifyLine(line: string): LineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

const LINE_STYLES: Record<LineKind, CSSProperties> = {
  add: { background: '#e6ffec', color: '#1a7f37' },
  del: { background: '#ffebe9', color: '#cf222e' },
  hunk: { background: '#ddf4ff', color: '#0969da' },
  meta: { color: '#57606a', fontWeight: 600 },
  ctx: { color: '#24292f' }
}

export default function DiffView({ diff }: DiffViewProps) {
  return (
    <pre style={{ margin: 0, padding: 8, overflowX: 'auto', background: '#fff', border: '1px solid #eee', borderRadius: 6, fontSize: 12, lineHeight: 1.5, fontFamily: 'ui-monospace, Consolas, monospace' }}>
      {diff.split('\n').map((line, index) => (
        <span key={index} style={{ display: 'block', padding: '0 4px', whiteSpace: 'pre', ...LINE_STYLES[classifyLine(line)] }}>
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}
