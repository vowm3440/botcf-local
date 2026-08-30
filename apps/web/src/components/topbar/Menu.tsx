import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CAPTION, CHROME, NUMERIC } from './chrome'

/** The popover the bar hides its settings in, and the pieces that go inside it.
 *
 *  Chrome should show state and hide configuration: what OMP channel to track or
 *  which directory the agent works in is decided once and then read never, so it
 *  does not deserve permanent pixels. Everything that used to sit in the bar as a
 *  button lives here, grouped by the thing it acts on.
 *
 *  Dismissal is the usual triple — outside pointer, Escape, and toggling the
 *  trigger — with the trigger rendered inside the popover's own wrapper so an
 *  outside-click never races the button's own toggle. */

export interface PopoverProps {
  ariaLabel: string
  width?: number
  renderTrigger: (state: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
}

export function Popover({ ariaLabel, width = 320, renderTrigger, children }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <span ref={wrapper} style={{ position: 'relative', flex: 'none', display: 'inline-flex' }}>
      {renderTrigger({ open, toggle: () => setOpen((prev) => !prev) })}
      {open && (
        <div
          role="dialog"
          aria-label={ariaLabel}
          style={{
            position: 'absolute',
            // Clears the 44px bar plus a few pixels, measured from the trigger.
            top: 'calc(100% + 14px)',
            right: 0,
            width,
            maxHeight: 'min(72vh, 620px)',
            overflowY: 'auto',
            padding: '6px 12px 10px',
            background: '#fff',
            border: '1px solid rgba(27,31,36,.10)',
            borderRadius: 12,
            boxShadow: '0 12px 32px rgba(31,35,40,.16), 0 1px 2px rgba(31,35,40,.10)',
            fontSize: 12,
            color: CHROME.ink,
            textAlign: 'left',
            zIndex: 60
          }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  )
}

export interface MenuSectionProps {
  title: string
  /** Right-aligned status for the section header, e.g. a version or a count. */
  aside?: ReactNode
  first?: boolean
  children: ReactNode
}

export function MenuSection({ title, aside, first = false, children }: MenuSectionProps) {
  return (
    <section
      style={{
        paddingTop: first ? 8 : 12,
        marginTop: first ? 0 : 4,
        borderTop: first ? undefined : `1px solid ${CHROME.hairline}`
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {/* 11px rather than the 10px a Latin section label could take: these are
            Chinese, and CJK glyphs lose their strokes a pixel sooner. */}
        <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: 0.5, color: CHROME.inkTertiary }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {aside}
      </header>
      {children}
    </section>
  )
}

/** Label on the left, value on the right — the shape of every fact in the menu. */
export function MenuRow({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div title={title} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '2px 0' }}>
      <span style={{ ...CAPTION, flex: 'none' }}>{label}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 12, color: CHROME.ink, textAlign: 'right', ...NUMERIC }}>{children}</span>
    </div>
  )
}

export function MenuActions({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 6 }}>{children}</div>
}

export interface InlineFormProps {
  value: string
  placeholder: string
  ariaLabel: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  pending?: boolean
}

/** One-field form: Enter commits, Escape backs out, and the row disappears
 *  again once the value is set. Configuration should not leave furniture behind. */
export function InlineForm({
  value,
  placeholder,
  ariaLabel,
  onChange,
  onSubmit,
  onCancel,
  pending = false
}: InlineFormProps) {
  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
      <input
        value={value}
        autoFocus
        spellCheck={false}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit()
          if (event.key === 'Escape') onCancel()
        }}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          padding: '3px 7px',
          border: `1px solid ${CHROME.hairline}`,
          borderRadius: 6,
          outline: 'none'
        }}
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={pending || !value.trim()}
        style={{
          flex: 'none',
          fontSize: 12,
          padding: '3px 10px',
          border: 'none',
          borderRadius: 6,
          background: pending || !value.trim() ? 'rgba(27,31,36,.06)' : CHROME.accent,
          color: pending || !value.trim() ? CHROME.inkTertiary : '#fff',
          cursor: pending || !value.trim() ? 'default' : 'pointer'
        }}
      >
        {pending ? '保存中…' : '保存'}
      </button>
    </div>
  )
}
