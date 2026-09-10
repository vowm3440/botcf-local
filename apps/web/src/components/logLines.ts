/** Merge ordered snapshots and live output by sequence, including older lines
 * that arrive after newer SSE frames. Keep only the newest bounded window. */
export function mergeLogLines<T extends { seq: number }>(
  previous: readonly T[],
  incoming: readonly T[],
  limit: number,
  after = 0
): T[] {
  const merged: T[] = []
  let left = previous.length - 1
  let right = incoming.length - 1
  while (merged.length < limit && (left >= 0 || right >= 0)) {
    let line: T
    if (right < 0 || (left >= 0 && previous[left].seq > incoming[right].seq)) {
      line = previous[left--]
    } else {
      line = incoming[right--]
      if (left >= 0 && previous[left].seq === line.seq) left--
    }
    if (line.seq <= after) break
    merged.push(line)
  }
  return merged.reverse()
}
