import { type EditRegion, regionEnd } from './editRegions'

/** The inline view's row list: the file, with what the assistant removed put back
 *  where it was taken from.
 *
 *  A unified diff shows a change with three lines of context around it, which is the
 *  right shape for reviewing a commit and the wrong one for reading code — you cannot
 *  see the function the change sits in. This builds the other shape: the real file,
 *  with removed lines reinserted at their old position and unchanged stretches either
 *  shown in full or collapsed to one "N 行未改动" row.
 *
 *  Pure, and separate from the component, because the interesting cases are all
 *  arithmetic: a deletion at the end of the file, two regions closer together than
 *  twice the context, a region whose start no longer exists. */

export type InlineRowKind = 'context' | 'added' | 'removed' | 'gap'

export interface InlineRow {
  kind: InlineRowKind
  /** 1-based line in the current file; null for removed and gap rows, which have no
   *  line of their own. */
  line: number | null
  text: string
  /** The counterpart of a replaced line, for word-level emphasis. */
  paired?: string
  /** Unchanged lines a gap row stands for. */
  skipped?: number
}

export interface InlineRowOptions {
  /** Unchanged lines kept either side of a region. */
  context?: number
  /** Render every line instead of collapsing the unchanged stretches. */
  full?: boolean
}

export const DEFAULT_INLINE_CONTEXT = 3

/** Build the rows. `regions` must be anchored to `lines` and non-overlapping —
 *  `trackEdits` returns them that way. */
export function buildInlineRows(
  lines: readonly string[],
  regions: readonly EditRegion[],
  options: InlineRowOptions = {}
): InlineRow[] {
  const context = Math.max(0, options.context ?? DEFAULT_INLINE_CONTEXT)
  const usable = regions.filter((region) => region.start <= lines.length + 1)
  const visible = options.full ? null : visibleLines(usable, lines.length, context)
  /** Regions keyed by the line their removed text sits above. */
  const openings = new Map<number, EditRegion[]>()
  for (const region of usable) {
    const existing = openings.get(region.start)
    if (existing) existing.push(region)
    else openings.set(region.start, [region])
  }
  /** Which region owns each added line, and its offset inside that region. */
  const owners = new Map<number, { region: EditRegion; offset: number }>()
  for (const region of usable) {
    for (let line = region.start; line <= regionEnd(region); line++) {
      if (line >= 1 && line <= lines.length) owners.set(line, { region, offset: line - region.start })
    }
  }

  const rows: InlineRow[] = []
  let skipped = 0
  const closeGap = (): void => {
    if (skipped === 0) return
    rows.push({ kind: 'gap', line: null, text: '', skipped })
    skipped = 0
  }

  for (let line = 1; line <= lines.length + 1; line++) {
    const shown = visible === null ? line <= lines.length : visible.has(line)
    const starting = openings.get(line)
    // A removed block is only worth showing where its position is on screen; the one
    // past the last line always is, since it is the tail of the file.
    if (starting && (shown || line === lines.length + 1)) {
      closeGap()
      for (const region of starting) {
        region.removedText.forEach((text, offset) => {
          rows.push({ kind: 'removed', line: null, text, paired: pairedAdded(region, lines, offset) })
        })
      }
    }
    if (line > lines.length) break
    if (!shown) {
      skipped++
      continue
    }
    closeGap()
    const owner = owners.get(line)
    rows.push(
      owner
        ? {
            kind: 'added',
            line,
            text: lines[line - 1],
            ...(owner.region.removedText[owner.offset] !== undefined
              ? { paired: owner.region.removedText[owner.offset] }
              : {})
          }
        : { kind: 'context', line, text: lines[line - 1] }
    )
  }
  closeGap()
  return rows
}

/** The added line a removed line was replaced by, when the region swapped them
 *  one for one. */
function pairedAdded(region: EditRegion, lines: readonly string[], offset: number): string | undefined {
  const line = region.start + offset
  if (offset >= region.count || line < 1 || line > lines.length) return undefined
  return lines[line - 1]
}

/** Line numbers inside any region's context window. */
function visibleLines(regions: readonly EditRegion[], lineCount: number, context: number): Set<number> {
  const visible = new Set<number>()
  for (const region of regions) {
    const from = Math.max(1, region.start - context)
    // A deletion covers no line, so its window is centred on where it happened.
    const to = Math.min(lineCount, Math.max(region.start, regionEnd(region)) + context)
    for (let line = from; line <= to; line++) visible.add(line)
  }
  return visible
}
