/** Word-level emphasis for a replaced line pair.
 *
 *  A one-character change on a 120-column line renders as two fully coloured rows,
 *  and the reader has to diff them by eye — which is the one thing a diff view
 *  exists to spare them. So a deleted line and the addition that replaced it are
 *  reduced to their common prefix, the part that actually changed, and their common
 *  suffix; only the middle is emphasized.
 *
 *  Pure and shared: the unified diff view and the inline (full-context) view both
 *  need the same pairing, and two implementations of it would drift. */

export interface WordSegment {
  text: string
  /** True for the part that differs between the two lines. */
  emphasized: boolean
}

/** Split a removed/added line pair into [removed segments, added segments].
 *  Identical lines yield one unemphasized segment each. */
export function wordSegments(removed: string, added: string): [WordSegment[], WordSegment[]] {
  let prefix = 0
  while (prefix < removed.length && prefix < added.length && removed[prefix] === added[prefix]) prefix++
  let suffix = 0
  while (
    suffix < removed.length - prefix &&
    suffix < added.length - prefix &&
    removed[removed.length - 1 - suffix] === added[added.length - 1 - suffix]
  ) suffix++
  return [splitLine(removed, prefix, suffix), splitLine(added, prefix, suffix)]
}

function splitLine(text: string, prefix: number, suffix: number): WordSegment[] {
  const segments: WordSegment[] = []
  if (prefix > 0) segments.push({ text: text.slice(0, prefix), emphasized: false })
  const middle = text.slice(prefix, text.length - suffix)
  if (middle) segments.push({ text: middle, emphasized: true })
  if (suffix > 0) segments.push({ text: text.slice(text.length - suffix), emphasized: false })
  return segments
}
