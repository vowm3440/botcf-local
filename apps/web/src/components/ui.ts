import type { CSSProperties } from 'react'
import { color, font, radius, text } from '../design/tokens'

/** Shared inline-style vocabulary for the panels inside the dock.
 *
 *  The app styles with inline objects (no CSS framework), so without a shared set
 *  every new panel re-invents the same button and toolbar — and a workbench whose
 *  ten panels each invented their own grey is the thing this file exists to
 *  prevent. Everything here reads from the design tokens, so the panels and the
 *  dock chrome around them stay one design rather than two.
 *
 *  Anything genuinely panel-specific stays local to that panel. */

export const MONO = font.mono

export const BUTTON: CSSProperties = {
  ...text.label,
  padding: '3px 10px',
  borderRadius: radius.r1,
  border: `1px solid ${color.lineStrong}`,
  background: color.surface,
  color: color.ink,
  cursor: 'pointer',
  // A dock panel can be dragged down to a few hundred pixels. Without these a
  // flex row keeps squeezing its buttons until the label breaks one character per
  // line — 「运行」 stacked vertically. The label is the smallest part of the row:
  // whatever has to give way, it is not this.
  whiteSpace: 'nowrap',
  flexShrink: 0
}

export const PRIMARY_BUTTON: CSSProperties = {
  ...BUTTON,
  border: `1px solid transparent`,
  background: color.accent,
  color: color.inkInverse,
  fontWeight: 600
}

export const DANGER_BUTTON: CSSProperties = {
  ...BUTTON,
  border: `1px solid ${color.red}`,
  color: color.red
}

export const SELECT: CSSProperties = { ...text.label, maxWidth: 180 }

export const INPUT: CSSProperties = {
  ...text.label,
  padding: '4px 7px',
  border: `1px solid ${color.lineStrong}`,
  borderRadius: radius.r1,
  background: color.surface,
  minWidth: 0
}

/** Panel root: fills its dock cell and never scrolls as a whole. */
export const PANEL_BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  background: color.surface,
  overflow: 'hidden'
}

export const TOOLBAR: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  alignItems: 'center',
  padding: '6px 8px',
  borderBottom: `1px solid ${color.line}`,
  flex: 'none'
}

export const STATUS_LINE: CSSProperties = {
  ...text.micro,
  padding: '4px 8px',
  color: color.ink2,
  borderBottom: `1px solid ${color.line}`,
  flex: 'none',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

export const SCROLL_AREA: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' }

export const EMPTY_HINT: CSSProperties = { ...text.body, padding: 14, color: color.ink3, lineHeight: 1.7 }

export const ROW: CSSProperties = {
  ...text.label,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  borderBottom: `1px solid ${color.line}`
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString()
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.round((ms % 60_000) / 1_000)}s`
}

/** Compact relative age, for lists sorted by recency. */
export function formatAge(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`
  return new Date(at).toLocaleDateString()
}
