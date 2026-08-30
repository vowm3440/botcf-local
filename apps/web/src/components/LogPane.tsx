import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { MONO } from './ui'

/** Scrollback pane shared by the terminal and the task runner.
 *
 *  Both show a long stream of lines that must stay readable: a dark monospace
 *  pane, per-line tone (stderr / echoed input / our own notes), and "stick to the
 *  bottom unless the user scrolled up to read" — following output must never fight
 *  someone trying to look at an earlier error. */

export type LogTone = 'out' | 'err' | 'in' | 'sys'

export interface LogEntry {
  key: string | number
  text: string
  tone: LogTone
  /** Optional prefix (a timestamp, a stream marker). */
  prefix?: string
}

const TONE_COLORS: Record<LogTone, string> = {
  out: '#d7dae0',
  err: '#ff9d9d',
  in: '#8ad0ff',
  sys: '#9aa4b2'
}

export interface LogPaneProps {
  entries: readonly LogEntry[]
  emptyText?: string
  /** Extra content pinned under the log (an input line). */
  footer?: ReactNode
}

export default function LogPane({ entries, emptyText = '(暂无输出)', footer }: LogPaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** Follow new output only while the view is already at the bottom. */
  const stick = useRef(true)

  useEffect(() => {
    const element = scrollRef.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [entries])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#0f1115' }}>
      <div
        ref={scrollRef}
        onScroll={() => {
          const element = scrollRef.current
          if (!element) return
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
        }}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '6px 8px',
          fontFamily: MONO,
          fontSize: 11,
          lineHeight: 1.55
        }}
      >
        {entries.length === 0 ? (
          <div style={{ color: '#6b7280' }}>{emptyText}</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.key}
              style={{
                color: TONE_COLORS[entry.tone],
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontWeight: entry.tone === 'in' ? 600 : 400
              }}
            >
              {entry.prefix ? <span style={{ color: '#5c6675' }}>{entry.prefix} </span> : null}
              {entry.text || ' '}
            </div>
          ))
        )}
      </div>
      {footer}
    </div>
  )
}
