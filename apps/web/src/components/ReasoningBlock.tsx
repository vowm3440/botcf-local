import { useEffect, useRef } from 'react'
import { color, font, text } from '../design/tokens'

/** The model's thinking for one turn.
 *
 *  This block exists because dropping reasoning was worse than showing it: a turn
 *  that thinks, emits a blank visible part and then calls a tool used to render as
 *  an empty gap, so a long pause looked like a hung stream. Now the reasoning is
 *  what fills that pause — expanded while it is the only thing the model has
 *  produced, collapsed the moment a real answer starts.
 *
 *  Streaming text pins to the bottom the way a terminal does, but only while the
 *  block is the live one; a reader who opened an old turn is left alone. */

export interface ReasoningBlockProps {
  reasoning: string
  /** Open the disclosure — true while thinking is all there is to show. */
  expanded: boolean
  /** Follow the tail as deltas arrive. */
  live: boolean
}

export default function ReasoningBlock({ reasoning, expanded, live }: ReasoningBlockProps) {
  const body = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!live || !expanded) return
    const el = body.current
    if (el) el.scrollTop = el.scrollHeight
  }, [expanded, live, reasoning])

  return (
    <details
      open={expanded}
      style={{
        marginTop: 6,
        borderLeft: `2px solid ${color.line}`,
        paddingLeft: 8
      }}
    >
      <summary
        style={{
          ...text.micro,
          cursor: 'pointer',
          color: color.ink3,
          listStyle: 'none'
        }}
      >
        {live && expanded ? '思考中…' : '思考过程'}
      </summary>
      <div
        ref={body}
        style={{
          ...text.micro,
          fontFamily: font.mono,
          color: color.ink3,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          maxHeight: 200,
          overflowY: 'auto',
          marginTop: 4
        }}
      >
        {reasoning}
      </div>
    </details>
  )
}
