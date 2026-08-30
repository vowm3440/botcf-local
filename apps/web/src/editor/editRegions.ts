/** AI edit tracking: a unified diff, expressed as regions of the file on disk.
 *
 *  The agent reports what it changed as unified diff text. That is the right thing
 *  to *show* in a diff tab, but the wrong thing to reason with: to mark the editor's
 *  gutter, to jump between changes, or to say "the assistant touched these 3 places",
 *  the UI needs line ranges in the file as it exists now. That is what this module
 *  produces, in two steps that are deliberately separate:
 *
 *  1. `parseEditRegions` reads the diff into regions in *new-file* coordinates.
 *  2. `anchorRegions` re-seats those regions against the file's real content.
 *
 *  Step 2 is the honest part. A region's line numbers stop being true the moment
 *  anything else changes the file — the next turn edits it above, or the user types a
 *  line — and the diff text carries no way to notice. So a region also remembers the
 *  lines it added, and anchoring re-finds that block: exact position first, then a
 *  window either side. A block that cannot be found is *dropped* rather than drawn at
 *  a stale line number, because a green bar next to code the assistant never wrote is
 *  worse than no bar at all.
 *
 *  Everything here is pure: no DOM, no fetches, no React. The rules are fiddly
 *  (concatenated diffs, hunk-less tool output, deletions that occupy no line) and
 *  they are the kind of thing that is invisible in a screenshot, so they are tested
 *  directly. */

export type EditKind = 'add' | 'modify' | 'delete'

export interface EditRegion {
  kind: EditKind
  /** 1-based first line of the region in the new file. A pure deletion occupies no
   *  line, so this is the line that now sits where the removed text was — which may
   *  be one past the end of the file. */
  start: number
  /** New-file lines the region covers; 0 for a pure deletion. */
  count: number
  added: number
  removed: number
  /** The added lines, kept so the region can be re-anchored against real content. */
  addedText: readonly string[]
  /** The removed lines, kept so the inline view can show them in place. */
  removedText: readonly string[]
}

export interface EditRegions {
  regions: EditRegion[]
  added: number
  removed: number
  /** True when the line numbers were inferred rather than read from `@@` headers,
   *  or when several diffs for the same file were concatenated — in both cases the
   *  positions are a starting guess for anchoring, not a fact. */
  approximate: boolean
}

export interface DiffCounts {
  added: number
  removed: number
}

export const EMPTY_EDIT_REGIONS: EditRegions = { regions: [], added: 0, removed: 0, approximate: false }

export const NO_DIFF_COUNTS: DiffCounts = { added: 0, removed: 0 }

/** How far either side of its recorded position a region's added block is looked
 *  for. Wide enough to survive a few edits above it, narrow enough that a repeated
 *  block elsewhere in the file is not mistaken for it. */
export const DEFAULT_ANCHOR_WINDOW = 400

/** Lines of the added block compared while scanning for its new position. A dozen
 *  identical consecutive lines is conclusive in practice, and bounds the scan for a
 *  region that rewrote a whole file. */
const PROBE_LINES = 12

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const FILE_HEADER = /^(diff |index |old mode|new mode|new file|deleted file|similarity |rename |copy |Binary )/

/** `--- ` and `+++ ` are file headers in the header zone and content once a hunk has
 *  opened — a diff that adds the literal line `+++ x` is indistinguishable from a
 *  header by prefix alone. Inside a hunk, one is only a header if it looks like the
 *  start of another diff appended after this one. */
function isFileHeader(lines: readonly string[], index: number, inHunk: boolean): boolean {
  const line = lines[index]
  if (line.startsWith('--- ')) {
    if (!inHunk) return true
    return /^\+\+\+ /.test(lines[index + 1] ?? '') || /^(a\/|\/dev\/null)/.test(line.slice(4))
  }
  if (line.startsWith('+++ ')) {
    if (!inHunk) return true
    return (
      /^@@ /.test(lines[index + 1] ?? '') ||
      /^(b\/|\/dev\/null)/.test(line.slice(4)) ||
      (lines[index - 1] ?? '').startsWith('--- ')
    )
  }
  return false
}

function makeRegion(start: number, removedText: string[], addedText: string[]): EditRegion {
  const added = addedText.length
  const removed = removedText.length
  return {
    kind: added > 0 && removed > 0 ? 'modify' : added > 0 ? 'add' : 'delete',
    start,
    count: added,
    added,
    removed,
    addedText,
    removedText
  }
}

/** Read a unified diff into regions. Accepts what this app actually holds: git-style
 *  diffs with `@@` headers, bare tool diffs with none, and several of either
 *  concatenated for one file across a turn. */
export function parseEditRegions(diff: string): EditRegions {
  if (!diff) return EMPTY_EDIT_REGIONS
  const lines = diff.split('\n')
  const regions: EditRegion[] = []
  let removedText: string[] = []
  let addedText: string[] = []
  let runStart = 1
  /** Next new-file line number a `+` or context line will occupy. */
  let newNo = 1
  let inHunk = false
  let sawHunk = false
  let segments = 1
  let lastHunkStart = -1

  const flush = (): void => {
    if (removedText.length === 0 && addedText.length === 0) return
    regions.push(makeRegion(runStart, removedText, addedText))
    removedText = []
    addedText = []
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (FILE_HEADER.test(line) || isFileHeader(lines, index, inHunk)) {
      flush()
      // A header after a hunk means another diff for this file was appended; its
      // line numbers describe the file *after* the earlier one applied, so the
      // positions become a guess that anchoring has to confirm.
      if (inHunk) segments++
      inHunk = false
      continue
    }

    const hunk = HUNK_HEADER.exec(line)
    if (hunk) {
      flush()
      const start = parseInt(hunk[2], 10)
      if (sawHunk && start < lastHunkStart) segments++
      lastHunkStart = start
      newNo = start
      inHunk = true
      sawHunk = true
      continue
    }

    if (line.startsWith('+')) {
      if (removedText.length === 0 && addedText.length === 0) runStart = newNo
      addedText.push(line.slice(1))
      newNo++
      continue
    }

    if (line.startsWith('-')) {
      if (removedText.length === 0 && addedText.length === 0) runStart = newNo
      removedText.push(line.slice(1))
      continue
    }

    // `\ No newline at end of file` describes the line before it rather than being
    // one, so it neither ends a run nor advances the line counter — a deletion and
    // the addition that replaced it stay one region across it.
    if (line.startsWith('\\')) continue

    // Context, or unrecognised chatter: either way the run of changed lines ends.
    flush()
    newNo++
  }
  flush()

  return {
    regions,
    added: regions.reduce((sum, region) => sum + region.added, 0),
    removed: regions.reduce((sum, region) => sum + region.removed, 0),
    approximate: !sawHunk || segments > 1
  }
}

/** Added/removed line totals without building regions — what a badge needs. */
export function countDiffLines(diff: string | undefined): DiffCounts {
  if (!diff) return NO_DIFF_COUNTS
  let added = 0
  let removed = 0
  const lines = diff.split('\n')
  let inHunk = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (FILE_HEADER.test(line) || isFileHeader(lines, index, inHunk)) {
      inHunk = false
      continue
    }
    if (HUNK_HEADER.test(line)) {
      inHunk = true
      continue
    }
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return added === 0 && removed === 0 ? NO_DIFF_COUNTS : { added, removed }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/** Does `block`'s first `probe` lines sit at `index`, with room for all of it? */
function blockMatches(lines: readonly string[], index: number, block: readonly string[], probe: number): boolean {
  if (index < 0 || index + block.length > lines.length) return false
  for (let offset = 0; offset < probe; offset++) {
    if (lines[index + offset] !== block[offset]) return false
  }
  return true
}

/** Offset from `index` at which the block sits now, nearest first, or null. */
function findOffset(lines: readonly string[], index: number, block: readonly string[], window: number): number | null {
  const probe = Math.min(block.length, PROBE_LINES)
  if (blockMatches(lines, index, block, probe)) return 0
  // A block whose leading lines are all blank matches almost anywhere; searching
  // for one would invent a position. Its recorded place is all there is to go on.
  if (!block.slice(0, probe).some((line) => line.trim() !== '')) return null
  for (let distance = 1; distance <= window; distance++) {
    if (blockMatches(lines, index + distance, block, probe)) return distance
    if (blockMatches(lines, index - distance, block, probe)) return -distance
  }
  return null
}

/** Re-seat regions against the file's current lines, dropping those whose added
 *  text is no longer there. Deletions occupy no lines and so cannot be verified;
 *  they are kept, clamped into the file, because "something was removed near here"
 *  stays true after edits elsewhere. */
export function anchorRegions(
  regions: readonly EditRegion[],
  lines: readonly string[],
  options: { window?: number } = {}
): EditRegion[] {
  const window = Math.max(0, options.window ?? DEFAULT_ANCHOR_WINDOW)
  const anchored: EditRegion[] = []
  for (const region of regions) {
    if (region.count === 0 || region.addedText.length === 0) {
      const highest = region.count === 0 ? lines.length + 1 : Math.max(lines.length, 1)
      const start = clamp(region.start, 1, Math.max(highest, 1))
      anchored.push({ ...region, start, count: Math.max(0, Math.min(region.count, lines.length - start + 1)) })
      continue
    }
    const offset = findOffset(lines, region.start - 1, region.addedText, window)
    if (offset === null) continue
    anchored.push({ ...region, start: region.start + offset, count: region.addedText.length })
  }
  return sortRegions(anchored)
}

function sortRegions(regions: readonly EditRegion[]): EditRegion[] {
  return [...regions].sort((left, right) => left.start - right.start || left.count - right.count)
}

/** Last line a region covers; one less than `start` for a pure deletion. */
export function regionEnd(region: EditRegion): number {
  return region.start + region.count - 1
}

function mergePair(left: EditRegion, right: EditRegion): EditRegion {
  const start = Math.min(left.start, right.start)
  const end = Math.max(regionEnd(left), regionEnd(right))
  const added = left.added + right.added
  const removed = left.removed + right.removed
  // Concatenating the added text is only faithful when the two ranges abut exactly;
  // otherwise it would describe lines twice and mislead a later re-anchoring.
  const abutting = regionEnd(left) + 1 === right.start
  return {
    kind: added > 0 && removed > 0 ? 'modify' : added > 0 ? 'add' : 'delete',
    start,
    count: Math.max(0, end - start + 1),
    added,
    removed,
    addedText: abutting ? [...left.addedText, ...right.addedText] : [],
    removedText: [...left.removedText, ...right.removedText]
  }
}

/** Fold touching and overlapping regions together, so one edit that arrived as
 *  three tool calls draws one bar instead of three. */
export function mergeRegions(regions: readonly EditRegion[]): EditRegion[] {
  const merged: EditRegion[] = []
  for (const region of sortRegions(regions)) {
    const previous = merged[merged.length - 1]
    if (previous && region.start <= regionEnd(previous) + 1) {
      merged[merged.length - 1] = mergePair(previous, region)
      continue
    }
    merged.push(region)
  }
  return merged
}

/** Re-seat and fold an already-parsed diff. Kept separate from parsing because the
 *  two have very different costs: the diff is parsed once when it arrives, while the
 *  anchoring has to be redone against the buffer as the user types in it. */
export function applyAnchors(
  parsed: EditRegions,
  lines: readonly string[],
  options: { window?: number } = {}
): EditRegions {
  const regions = mergeRegions(anchorRegions(parsed.regions, lines, options))
  return {
    regions,
    added: regions.reduce((sum, region) => sum + region.added, 0),
    removed: regions.reduce((sum, region) => sum + region.removed, 0),
    approximate: parsed.approximate
  }
}

/** Regions of the file as it is now: parse, re-seat, fold. The one call a view
 *  needs. */
export function trackEdits(
  diff: string | undefined,
  lines: readonly string[],
  options: { window?: number } = {}
): EditRegions {
  if (!diff) return EMPTY_EDIT_REGIONS
  return applyAnchors(parseEditRegions(diff), lines, options)
}

/** True when anchoring could not find some of what the diff claims — the file moved
 *  on and those regions are no longer drawn anywhere. */
export function hasStaleRegions(parsed: EditRegions, anchored: EditRegions): boolean {
  return parsed.added > anchored.added || parsed.removed > anchored.removed
}

/** Next region starting after `line`, wrapping to the first — so the same key can
 *  be pressed repeatedly to walk every change. */
export function nextRegion(regions: readonly EditRegion[], line: number): EditRegion | null {
  if (regions.length === 0) return null
  return regions.find((region) => region.start > line) ?? regions[0]
}

export function previousRegion(regions: readonly EditRegion[], line: number): EditRegion | null {
  if (regions.length === 0) return null
  for (let index = regions.length - 1; index >= 0; index--) {
    if (regions[index].start < line) return regions[index]
  }
  return regions[regions.length - 1]
}

/** Per-path added/removed totals for the tree, the tab strip and the status bar. */
export function buildDiffCounts(files: Iterable<{ path: string; diff?: string }>): Map<string, DiffCounts> {
  const counts = new Map<string, DiffCounts>()
  for (const file of files) {
    const count = countDiffLines(file.diff)
    if (count.added > 0 || count.removed > 0) counts.set(file.path, count)
  }
  return counts
}

export function totalDiffCounts(counts: Iterable<DiffCounts>): DiffCounts {
  let added = 0
  let removed = 0
  for (const count of counts) {
    added += count.added
    removed += count.removed
  }
  return { added, removed }
}
