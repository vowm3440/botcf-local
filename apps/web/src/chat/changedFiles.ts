import type { ChangedFileInfo } from '../api'

/** Bookkeeping for "which files did this session change".
 *
 *  Two sources feed the same picture: tool-call frames as they stream in, and the
 *  authoritative per-turn summary that arrives at the end of a turn. Both can
 *  describe the same file, so merging has to be associative and has to bound the
 *  diff it accumulates — a long session that keeps editing one file would
 *  otherwise grow an unbounded string in memory. Pure so the merge rules can be
 *  tested without a stream. */

/** Upper bound on the diff kept per file; the tail is what a reader wants. */
export const DIFF_CAP = 200_000

function joinDiffs(previous: string | undefined, next: string | undefined): string | undefined {
  const joined = [previous, next].filter((part): part is string => Boolean(part)).join('\n')
  if (!joined) return undefined
  return joined.length > DIFF_CAP ? joined.slice(joined.length - DIFF_CAP) : joined
}

/** Fold a newer record into an older one for the same path. The newer record wins
 *  on scalar fields; tools and diffs accumulate. */
export function mergeChangedFile(previous: ChangedFileInfo, next: ChangedFileInfo): ChangedFileInfo {
  const diff = joinDiffs(previous.diff, next.diff)
  return {
    ...next,
    tools: [...new Set([...previous.tools, ...next.tools])],
    hasDiff: previous.hasDiff || next.hasDiff,
    ...(diff ? { diff } : {})
  }
}

/** Fold a stream of records into one entry per path, keeping first-seen order. */
export function mergeChangedFiles(files: Iterable<ChangedFileInfo>): Map<string, ChangedFileInfo> {
  const merged = new Map<string, ChangedFileInfo>()
  for (const file of files) {
    const previous = merged.get(file.path)
    merged.set(file.path, previous ? mergeChangedFile(previous, file) : file)
  }
  return merged
}

/** Replace (or add) one path in a list of live records, merging with what is
 *  already there for that path. */
export function absorbChangedFile(files: readonly ChangedFileInfo[], entry: ChangedFileInfo): ChangedFileInfo[] {
  const previous = files.find((file) => file.path === entry.path)
  const merged = previous ? mergeChangedFile(previous, entry) : entry
  return [...files.filter((file) => file.path !== entry.path), merged]
}

/** Mirror of the server's mutating-tool heuristic (omp/fileChanges.ts), used only
 *  to decide whether a finished tool call should auto-open its file. */
const NON_MUTATING = /^(read|grep|glob|ls|list|find|search|fetch|web|browse|bash|shell|exec|run|todo|task|think|plan)/i
const MUTATING_STEM = /(edit|write|patch|create|replace|save|move|rename)/i

export function isMutatingToolName(name: string): boolean {
  return !NON_MUTATING.test(name) && MUTATING_STEM.test(name)
}
