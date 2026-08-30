import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { color, font, radius, text } from '../design/tokens'

/** The composer, shaped like a terminal coding agent's prompt.
 *
 *  One bordered box holds everything: a `›` marker, the field, and a footer strip
 *  that states the run's settings on the left and the keys on the right. That is
 *  the point of the shape — the things you would otherwise have to go and check
 *  (which model, which thinking level, whether tool calls still stop to ask) are
 *  written where you are already looking when you type.
 *
 *  The field itself is a textarea: it wraps (pre-wrap + break-word), is width-bound
 *  by `minWidth: 0` on both the box and the field, and grows from one row to
 *  `maxHeight` before scrolling internally. Enter sends, Shift+Enter inserts a
 *  newline, and an in-flight IME composition is never treated as a send. */

export interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** Stop the running turn. Present only while streaming. */
  onAbort?: () => void
  disabled?: boolean
  placeholder?: string
  /** Pixel height at which the field stops growing and starts scrolling. */
  maxHeight?: number
  ariaLabel?: string
  /** Footer left side: route, thinking level, access mode — one chip each. */
  chips?: ReactNode
  /** True while a turn is streaming: the action becomes 中止. */
  streaming?: boolean
  /** Mid-turn input steers the run instead of starting a new one. */
  canSteer?: boolean
}

/** One line of 13px/1.5 body text. The box hugs the field — the breathing room
 *  comes from the container's padding, so an empty composer is not a tall slab. */
const MIN_HEIGHT = 22
const DEFAULT_MAX_HEIGHT = 200

export default function ChatInput({
  value,
  onChange,
  onSubmit,
  onAbort,
  disabled = false,
  placeholder,
  maxHeight = DEFAULT_MAX_HEIGHT,
  ariaLabel = '消息输入框',
  chips,
  streaming = false,
  canSteer = false
}: ChatInputProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [focused, setFocused] = useState(false)

  // Re-measure on every value change: height must shrink again when text is
  // deleted, so reset to auto before reading scrollHeight.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), maxHeight)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [maxHeight, value])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // Enter during IME composition commits the candidate, it does not send.
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    onSubmit()
  }

  const empty = value.trim() === ''
  const hint = streaming
    ? canSteer
      ? '⏎ 追加引导 · ⇧⏎ 换行'
      : '生成中…'
    : '⏎ 发送 · ⇧⏎ 换行'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        borderRadius: radius.r2,
        border: `1px solid ${focused ? color.accent : color.lineStrong}`,
        background: disabled ? color.sunken : color.surface,
        boxShadow: focused ? `0 0 0 3px ${color.accentWash}` : 'none',
        transition: 'border-color 120ms ease, box-shadow 120ms ease'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '8px 10px 4px', minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            ...text.body,
            flex: 'none',
            fontFamily: font.mono,
            color: focused ? color.accent : color.ink3,
            lineHeight: '20px'
          }}
        >
          ›
        </span>
        <textarea
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={ariaLabel}
          rows={1}
          spellCheck={false}
          style={{
            ...text.body,
            flex: 1,
            // Without this a long unbroken line lets the flex item exceed the panel.
            minWidth: 0,
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box',
            minHeight: MIN_HEIGHT,
            maxHeight,
            padding: 0,
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontFamily: 'inherit',
            lineHeight: 1.5,
            color: color.ink,
            background: 'transparent',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word'
          }}
        />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px 6px 10px',
          minWidth: 0
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>{chips}</div>
        <span style={{ flex: 1, minWidth: 8 }} />
        <span style={{ ...text.micro, flex: 'none', color: color.ink3, whiteSpace: 'nowrap' }}>{hint}</span>
        {streaming && onAbort ? (
          <button
            onClick={onAbort}
            title="中止当前生成"
            style={{
              ...text.micro,
              flex: 'none',
              padding: '3px 9px',
              borderRadius: radius.r1,
              border: `1px solid ${color.red}`,
              background: 'transparent',
              color: color.red,
              cursor: 'pointer'
            }}
          >
            中止
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={disabled || empty}
            title={disabled ? '未选择路由' : '发送'}
            style={{
              ...text.micro,
              flex: 'none',
              padding: '3px 9px',
              borderRadius: radius.r1,
              border: '1px solid transparent',
              background: disabled || empty ? color.hover : color.accent,
              color: disabled || empty ? color.ink3 : color.inkInverse,
              fontWeight: 600,
              cursor: disabled || empty ? 'default' : 'pointer'
            }}
          >
            {'发送'}
          </button>
        )}
      </div>
    </div>
  )
}
