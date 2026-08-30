import type { CSSProperties } from 'react'

/** The token names, as TypeScript sees them.
 *
 *  Components style with inline objects, so they need the custom properties from
 *  tokens.css as strings. Going through this module rather than writing
 *  `var(--ink-2)` inline means a renamed token is a compile error instead of a
 *  colour that silently falls back to black. */

export const font = {
  ui: 'var(--ui-font)',
  mono: 'var(--mono-font)'
} as const

export const color = {
  surface: 'var(--surface)',
  sunken: 'var(--surface-sunken)',
  hover: 'var(--surface-hover)',
  chrome: 'var(--chrome)',
  chromeSolid: 'var(--chrome-solid)',
  rail: 'var(--rail)',
  line: 'var(--line)',
  lineStrong: 'var(--line-strong)',
  ink: 'var(--ink)',
  ink2: 'var(--ink-2)',
  ink3: 'var(--ink-3)',
  inkInverse: 'var(--ink-inverse)',
  accent: 'var(--accent)',
  accentPress: 'var(--accent-press)',
  accentWash: 'var(--accent-wash)',
  accentWashStrong: 'var(--accent-wash-strong)',
  red: 'var(--red)',
  redWash: 'var(--red-wash)',
  amber: 'var(--amber)',
  green: 'var(--green)'
} as const

export const radius = {
  r1: 'var(--r1)',
  r2: 'var(--r2)',
  r3: 'var(--r3)',
  pill: 'var(--r-pill)'
} as const

/** Chrome metrics, shared by the rail, the tab strips and the status strip so the
 *  rhythm survives someone editing one component. */
export const metric = {
  railWidth: 'var(--rail-w)',
  tabStripHeight: 'var(--tabstrip-h)',
  statusHeight: 'var(--status-h)'
} as const

/** Tracking is size-specific: display sizes read too loose, small text too tight.
 *  Leading moves the other way. Both come from the size, so they ship together.
 *
 *  Named `text` rather than `type` because `import { type ... }` means something
 *  else entirely in TypeScript. */
export const text = {
  /** 11px — status bar, badges, secondary counts. */
  micro: { fontSize: 11, letterSpacing: 0.1, lineHeight: 1.35 } satisfies CSSProperties,
  /** 12px — tabs, toolbars, list rows: most of the chrome. */
  label: { fontSize: 12, letterSpacing: 0, lineHeight: 1.4 } satisfies CSSProperties,
  /** 13px — body copy and panel prose. */
  body: { fontSize: 13, letterSpacing: -0.05, lineHeight: 1.55 } satisfies CSSProperties,
  /** 15px — the empty-state sentence, the only large type in the workbench. */
  title: { fontSize: 15, letterSpacing: -0.2, lineHeight: 1.3 } satisfies CSSProperties
} as const

/** Chrome that frames content: the tab strips, the rail, the status strip.
 *
 *  Opaque, deliberately. Translucency is a *material* — it earns its cost when
 *  content actually passes behind it, the way a floating toolbar sits over a
 *  scrolling page. These strips are in the flow: nothing is behind them but their
 *  own pane, so a blur here would be a GPU layer spent on an effect no one can
 *  see. The one surface in this workbench that really does float — the drag ghost —
 *  gets the real material, in dock.css. */
export const chromeSurface: CSSProperties = {
  background: color.chromeSolid
}
