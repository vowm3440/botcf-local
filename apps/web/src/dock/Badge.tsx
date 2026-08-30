import { color, radius, text } from '../design/tokens'

/** A count on a tab or a rail icon.
 *
 *  Blue for "there is something here", red for "something is wrong" — the only two
 *  things a number on a chrome element ever needs to say. Tabular figures so a
 *  count ticking from 9 to 10 does not shift the label next to it. */

export interface BadgeProps {
  count: number
  alert?: boolean
}

export default function Badge({ count, alert = false }: BadgeProps) {
  if (count <= 0) return null
  return (
    <span
      aria-hidden
      style={{
        ...text.micro,
        flex: 'none',
        minWidth: 15,
        padding: '0 4px',
        borderRadius: radius.pill,
        textAlign: 'center',
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
        background: alert ? color.red : color.accent,
        color: color.inkInverse
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
