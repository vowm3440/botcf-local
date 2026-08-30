/** The colours a diff is read in, in one place.
 *
 *  Three surfaces show the same change — the unified diff tab, the inline
 *  full-context view and the change bars in the editor gutter — and a green that
 *  disagrees between them reads as three different features. These are the GitHub
 *  diff values rather than the workbench tokens on purpose: a diff needs a *pair* of
 *  washes light enough to read code on, which the status colours in tokens.css are
 *  not, and every developer already knows what these two greens mean.
 *
 *  Bands are translucent so they can sit under selected text in the editor without
 *  hiding it; rows are opaque because the diff views own their whole surface. */

export const diffColor = {
  /** Full-row backgrounds for the unified and inline views. */
  addRow: '#e6ffec',
  delRow: '#ffebe9',
  ctxRow: '#ffffff',
  hunkRow: '#ddf4ff',
  metaRow: '#f6f8fa',
  /** The changed part of a replaced line. */
  addEmphasis: '#abf2bc',
  delEmphasis: '#ffc1c0',
  /** Translucent bands drawn behind live editor text. */
  addBand: 'rgba(45, 164, 78, 0.12)',
  modifyBand: 'rgba(9, 105, 218, 0.10)',
  /** Gutter bars, 2px wide, next to the line numbers. */
  addBar: '#2da44e',
  modifyBar: '#0969da',
  delBar: '#cf222e',
  /** Ink. */
  ink: '#24292f',
  addInk: '#1a7f37',
  delInk: '#cf222e',
  hunkInk: '#0969da',
  metaInk: '#57606a',
  gutterInk: '#8c959f'
} as const

/** One monospace row, everywhere. The gutter, the highlight bands and the text
 *  layer are three separate elements that must line up to the pixel, so the row
 *  height is a constant rather than a line-height multiplier — a computed 1.5 × 12
 *  rounds differently in different engines and the bands drift. */
export const CODE_LINE_HEIGHT = 18
export const CODE_FONT_SIZE = 12
/** Padding inside the text layers; the gutter and the bands share it. */
export const CODE_PAD_TOP = 6
