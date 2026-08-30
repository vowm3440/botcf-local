import type { ReactNode } from 'react'

/** The workbench icon set: sixteen-pixel monochrome strokes, drawn here rather
 *  than borrowed from emoji.
 *
 *  Emoji were the previous stand-in and they never line up — each one carries its
 *  own colour, weight and optical size, so a row of them reads as five unrelated
 *  pictures instead of one set. These share a box, a stroke width and
 *  `currentColor`, which is what makes a rail of them look drawn by one hand. */

export type IconName =
  | 'explorer'
  | 'scm'
  | 'run'
  | 'review'
  | 'config'
  | 'editor'
  | 'problems'
  | 'terminal'
  | 'preview'
  | 'chat'
  | 'logs'
  | 'layout'
  | 'zoom-in'
  | 'zoom-out'
  | 'close'

const GLYPHS: Readonly<Record<IconName, ReactNode>> = {
  explorer: (
    <path d="M2.25 5.4A1.65 1.65 0 0 1 3.9 3.75h2.45c.45 0 .88.2 1.18.54l.72.83h3.85a1.65 1.65 0 0 1 1.65 1.65v5.48a1.65 1.65 0 0 1-1.65 1.65H3.9a1.65 1.65 0 0 1-1.65-1.65Z" />
  ),
  scm: (
    <>
      <circle cx="4.75" cy="4" r="1.75" />
      <circle cx="4.75" cy="12" r="1.75" />
      <circle cx="11.5" cy="5.75" r="1.75" />
      <path d="M4.75 5.75v4.5M11.5 7.5v.75A2.75 2.75 0 0 1 8.75 11H6.5" />
    </>
  ),
  run: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.75 5.6 10.6 8l-3.85 2.4Z" />
    </>
  ),
  review: <path d="m3.25 8.5 3.25 3.25L12.75 4.75" />,
  config: (
    <>
      <path d="M2.5 5.25h5.25M12.25 5.25h1.25M2.5 10.75h1.25M8.5 10.75h5" />
      <circle cx="9.75" cy="5.25" r="1.6" />
      <circle cx="6.25" cy="10.75" r="1.6" />
    </>
  ),
  editor: (
    <>
      <path d="M4.4 2.5h4.35L12 5.9v6.85a1.35 1.35 0 0 1-1.35 1.35h-6.3A1.35 1.35 0 0 1 3 12.75V3.85A1.35 1.35 0 0 1 4.4 2.5Z" />
      <path d="M8.6 2.6v3.4H12" />
    </>
  ),
  problems: (
    <>
      <path d="M8 3.1l5.35 9.3H2.65Z" />
      <path d="M8 6.6v2.6M8 11.15h.01" />
    </>
  ),
  terminal: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.6" />
      <path d="m5.25 7 1.6 1.5-1.6 1.5M9 10h2.25" />
    </>
  ),
  preview: (
    <>
      <rect x="1.75" y="3.5" width="12.5" height="9" rx="1.6" />
      <path d="M1.75 6.5h12.5M4.25 5h.01M6 5h.01" />
    </>
  ),
  chat: (
    <path d="M14 8.4c0 2.85-2.69 5.15-6 5.15-.85 0-1.66-.15-2.4-.43L2.6 14.25l.87-2.6A4.98 4.98 0 0 1 2 8.4c0-2.84 2.69-5.15 6-5.15s6 2.31 6 5.15Z" />
  ),
  logs: <path d="M3 13V9.25M6.5 13V5.5M10 13v-2.75M13.5 13V3.5" />,
  layout: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M6.75 3v10M6.75 8.25H14" />
    </>
  ),
  'zoom-in': <path d="M9.75 2.75h3.5v3.5M6.25 13.25h-3.5v-3.5M13.25 2.75 9.5 6.5M2.75 13.25 6.5 9.5" />,
  'zoom-out': <path d="M13 6.5H9.5V3M3 9.5h3.5V13M9.5 6.5 13.25 2.75M6.5 9.5 2.75 13.25" />,
  close: <path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5" />
}

export interface IconProps {
  name: IconName
  /** Box size in px; the stroke thins as the box grows so weight stays constant. */
  size?: number
}

export default function Icon({ name, size = 16 }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={(1.5 * 16) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flex: 'none' }}
    >
      {GLYPHS[name]}
    </svg>
  )
}
