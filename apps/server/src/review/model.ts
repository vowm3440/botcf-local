/** Review state for the changes the agent made.
 *
 *  The agent writes files directly; the UI learns about it from the tool stream
 *  (omp/fileChanges.ts). This module is the *judgement* layer on top of that: for
 *  each touched file, has the user looked at it and decided to keep it or throw it
 *  away? A file that gets edited again after a decision goes back to pending —
 *  a stale approval is worse than no approval.
 *
 *  Pure and immutable, so the rules (re-edit resets, decisions survive across
 *  turns, diff budget) are unit-testable without git or a workspace. */

export type ReviewDecision = 'pending' | 'accepted' | 'reverted'

/** Minimal view of omp/fileChanges.ts ChangedFile — kept local to avoid coupling
 *  the review rules to the tool-stream module. */
export interface ChangedFileLike {
  path: string
  tools: string[]
  hasDiff: boolean
  isError: boolean
  diff?: string
}

export interface ReviewRecord {
  /** Qualified workspace path (`<rootName>/<relative>`) or absolute when outside. */
  path: string
  tools: string[]
  hasDiff: boolean
  isError: boolean
  /** Diff reported by the agent; the fallback when the root is not a git repo. */
  diff?: string
  /** Turn the change was last seen in (1-based). */
  turn: number
  firstAt: number
  lastAt: number
  decision: ReviewDecision
  /** When the decision was taken, so the panel can show "已接受 12:03". */
  decidedAt: number | null
}

export interface ReviewState {
  turn: number
  records: ReadonlyMap<string, ReviewRecord>
}

export const emptyReviewState: ReviewState = { turn: 0, records: new Map() }

/** Total agent-reported diff text kept in memory across all files. Beyond this,
 *  the oldest diffs are dropped (the records stay); git supplies the real diff
 *  anyway, and this is only the no-repository fallback. */
export const MAX_TOTAL_DIFF_CHARS = 2_000_000

function mergeTools(previous: readonly string[], next: readonly string[]): string[] {
  return [...new Set([...previous, ...next])]
}

/** Fold one finished turn's changed files into the review state. */
export function recordTurn(state: ReviewState, files: readonly ChangedFileLike[], now = Date.now()): ReviewState {
  if (files.length === 0) return state
  const turn = state.turn + 1
  const records = new Map(state.records)
  for (const file of files) {
    const previous = records.get(file.path)
    records.set(file.path, {
      path: file.path,
      tools: previous ? mergeTools(previous.tools, file.tools) : [...file.tools],
      hasDiff: (previous?.hasDiff ?? false) || file.hasDiff,
      isError: file.isError,
      ...(file.diff ? { diff: file.diff } : previous?.diff ? { diff: previous.diff } : {}),
      turn,
      firstAt: previous?.firstAt ?? now,
      lastAt: now,
      // A file changed again is unreviewed again, whatever was decided before.
      decision: 'pending',
      decidedAt: null
    })
  }
  return trimDiffBudget({ turn, records })
}

/** Drop the oldest stored diffs once the memory budget is exceeded. */
export function trimDiffBudget(state: ReviewState, budget = MAX_TOTAL_DIFF_CHARS): ReviewState {
  let total = 0
  for (const record of state.records.values()) total += record.diff?.length ?? 0
  if (total <= budget) return state
  const records = new Map(state.records)
  const oldestFirst = [...records.values()].sort((a, b) => a.lastAt - b.lastAt)
  for (const record of oldestFirst) {
    if (total <= budget) break
    if (!record.diff) continue
    total -= record.diff.length
    const { diff: _dropped, ...rest } = record
    records.set(record.path, { ...rest })
  }
  return { turn: state.turn, records }
}

export function setDecision(
  state: ReviewState,
  paths: readonly string[],
  decision: ReviewDecision,
  now = Date.now()
): ReviewState {
  const records = new Map(state.records)
  for (const path of paths) {
    const record = records.get(path)
    if (!record) continue
    records.set(path, { ...record, decision, decidedAt: decision === 'pending' ? null : now })
  }
  return { turn: state.turn, records }
}

/** Forget files entirely — used after a commit, when they are history. */
export function forgetPaths(state: ReviewState, paths: readonly string[]): ReviewState {
  const records = new Map(state.records)
  for (const path of paths) records.delete(path)
  return { turn: state.turn, records }
}

export function listRecords(state: ReviewState): ReviewRecord[] {
  return [...state.records.values()].sort((a, b) => b.lastAt - a.lastAt || a.path.localeCompare(b.path))
}

export interface ReviewSummary {
  total: number
  pending: number
  accepted: number
  reverted: number
  /** Files whose change failed and therefore need a look regardless. */
  failed: number
}

export function summarize(state: ReviewState): ReviewSummary {
  const records = [...state.records.values()]
  return {
    total: records.length,
    pending: records.filter((record) => record.decision === 'pending').length,
    accepted: records.filter((record) => record.decision === 'accepted').length,
    reverted: records.filter((record) => record.decision === 'reverted').length,
    failed: records.filter((record) => record.isError).length
  }
}

/** Paths with a given decision, in display order. */
export function pathsWithDecision(state: ReviewState, decision: ReviewDecision): string[] {
  return listRecords(state)
    .filter((record) => record.decision === decision)
    .map((record) => record.path)
}
