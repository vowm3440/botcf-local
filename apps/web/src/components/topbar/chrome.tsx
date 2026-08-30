import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** Visual vocabulary for the application chrome — the top bar and its menu.
 *
 *  The workbench panels have their own set in components/ui.ts, tuned for dense
 *  tabular data: visible borders, tight rows, many affordances. Chrome is the
 *  opposite problem. It is always on screen and is read at a glance, so it earns
 *  its structure from type weight, colour and whitespace instead of from boxes —
 *  the only lines in the bar are the hairline under it and two 16px dividers.
 *
 *  Neutrals are the Primer scale the workbench already uses (#e1e4e8 hairlines,
 *  #0969da accent), so the bar reads as the same product as the panels below. */

export const CHROME = {
  /** Fixed. The bar never wraps and never changes height with state. */
  height: 44,
  surface: '#fcfcfd',
  hairline: '#e1e4e8',
  divider: 'rgba(27,31,36,.14)',
  hover: 'rgba(27,31,36,.055)',
  ink: '#1f2328',
  inkSecondary: '#57606a',
  inkTertiary: '#8c959f',
  accent: '#0969da',
  accentSoft: '#ddf4ff',
  ok: '#1a7f37',
  warn: '#9a6700',
  warnSoft: '#fff8c5',
  danger: '#cf222e',
  dangerSoft: '#ffebe9',
  radius: 6
} as const

export type Tone = 'info' | 'ok' | 'warn' | 'danger'

export const TONE_INK: Record<Tone, string> = {
  info: CHROME.accent,
  ok: CHROME.ok,
  warn: CHROME.warn,
  danger: CHROME.danger
}

export const TONE_FILL: Record<Tone, string> = {
  info: CHROME.accentSoft,
  ok: '#dafbe1',
  warn: CHROME.warnSoft,
  danger: CHROME.dangerSoft
}

/** Numbers that update in place must not shift width as digits change. */
export const NUMERIC: CSSProperties = { fontVariantNumeric: 'tabular-nums' }

export const CAPTION: CSSProperties = { fontSize: 11, color: CHROME.inkTertiary, whiteSpace: 'nowrap' }

/** A horizontal group of related items inside the bar. */
export const CLUSTER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  whiteSpace: 'nowrap'
}

export function Divider() {
  return <span aria-hidden style={{ flex: 'none', width: 1, height: 16, background: CHROME.divider }} />
}

/** Status light: colour carries the state, the tooltip carries the words. */
export function Dot({ tone, title }: { tone: Tone; title?: string }) {
  return (
    <span
      title={title}
      style={{ flex: 'none', width: 6, height: 6, borderRadius: 999, background: TONE_INK[tone] }}
    />
  )
}

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        flex: 'none',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        background: TONE_FILL[tone],
        color: TONE_INK[tone],
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 280
      }}
    >
      {children}
    </span>
  )
}

interface GhostButtonProps {
  children: ReactNode
  onClick: () => void
  title?: string
  disabled?: boolean
  tone?: 'default' | 'accent' | 'danger'
  active?: boolean
  ariaLabel?: string
  ariaExpanded?: boolean
  ariaHasPopup?: 'menu' | 'dialog'
}

/** Borderless action. Chrome buttons stay invisible until pointed at, so a bar
 *  with eight of them still reads as one surface rather than a row of chiclets. */
export function GhostButton({
  children,
  onClick,
  title,
  disabled = false,
  tone = 'default',
  active = false,
  ariaLabel,
  ariaExpanded,
  ariaHasPopup
}: GhostButtonProps) {
  const [hover, setHover] = useState(false)
  const ink = tone === 'danger' ? CHROME.danger : tone === 'accent' ? CHROME.accent : CHROME.inkSecondary
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 8px',
        border: 'none',
        borderRadius: CHROME.radius,
        background: active || (hover && !disabled) ? CHROME.hover : 'transparent',
        color: disabled ? CHROME.inkTertiary : ink,
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        cursor: disabled ? 'default' : 'pointer'
      }}
    >
      {children}
    </button>
  )
}

export interface PickerOption {
  value: string
  label: string
  disabled?: boolean
  title?: string
}

interface PickerProps {
  value: string
  options: PickerOption[]
  onChange: (value: string) => void
  ariaLabel: string
  /** Empty-value entry; omitted once a value must always be present. */
  placeholder?: string
  disabled?: boolean
  /** The one item in a cluster that carries the identity, e.g. the model id. */
  strong?: boolean
  title?: string
  maxWidth?: number
  onOpen?: () => void
}

/** A native select stripped to text plus a chevron.
 *
 *  Native on purpose: keyboard, type-ahead and the platform popup are all free,
 *  and a custom listbox would be a lot of code to arrive somewhere worse. Only
 *  the closed state is restyled — that is the part that lives in the bar.
 *
 *  A bare select reserves the width of its *longest* option, which in a
 *  breadcrumb of model ids leaves a hole after the short ones. So an invisible
 *  copy of the selected label sets the width and the select is laid over it: the
 *  control ends up as wide as what it currently says, and the wrapper's maxWidth
 *  hands the overflow back to the browser to ellipsize. */
export function Picker({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
  strong = false,
  title,
  maxWidth = 220,
  onOpen
}: PickerProps) {
  const [hover, setHover] = useState(false)
  const selectedLabel = options.find((option) => option.value === value)?.label ?? placeholder ?? ''
  const text: CSSProperties = {
    fontSize: strong ? 13 : 12,
    fontWeight: strong ? 600 : 400,
    color: disabled ? CHROME.inkTertiary : strong ? CHROME.ink : CHROME.inkSecondary,
    padding: '3px 17px 3px 6px',
    lineHeight: '18px',
    whiteSpace: 'nowrap'
  }
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: 0,
        maxWidth,
        borderRadius: CHROME.radius,
        background: hover && !disabled ? CHROME.hover : 'transparent'
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span aria-hidden style={{ ...text, visibility: 'hidden', minWidth: 0, overflow: 'hidden' }}>
        {selectedLabel}
      </span>
      <select
        aria-label={ariaLabel}
        title={title}
        value={value}
        disabled={disabled}
        onFocus={onOpen}
        onChange={(event) => onChange(event.target.value)}
        style={{
          ...text,
          appearance: 'none',
          WebkitAppearance: 'none',
          MozAppearance: 'none',
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          border: 'none',
          background: 'transparent',
          outline: 'none',
          borderRadius: CHROME.radius,
          textOverflow: 'ellipsis',
          cursor: disabled ? 'default' : 'pointer'
        }}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled} title={option.title}>
            {option.label}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          right: 6,
          fontSize: 8,
          lineHeight: 1,
          color: disabled ? '#c6cbd1' : CHROME.inkTertiary,
          pointerEvents: 'none'
        }}
      >
        ▼
      </span>
    </span>
  )
}
