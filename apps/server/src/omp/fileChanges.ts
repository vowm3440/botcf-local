/** Per-turn changed-file tracking, fed by the normalized OMP tool events that
 *  routes/chat.ts already streams to the UI. Pure and immutable so every rule
 *  is unit-testable (OMP tool names and argument fields drift across versions). */

/** Minimal structural view of routes/chat.ts ToolStreamEvent — kept local to
 *  avoid a circular import. */
export interface ToolEventLike {
  phase: 'start' | 'update' | 'end'
  id: string
  name: string
  args?: unknown
  diff?: string
  isError?: boolean
}

export interface ChangedFile {
  /** Qualified workspace path (`<rootName>/<relative>`) when the file lives in a
   *  workspace root, absolute POSIX otherwise. */
  path: string
  /** Mutating tool names that touched the file, in first-seen order. */
  tools: string[]
  /** Latest mutating tool call — the UI anchors "jump to diff" on it. */
  lastToolCallId: string
  hasDiff: boolean
  /** True when the latest mutating call on this file ended in error. */
  isError: boolean
  /** Unified diffs accumulated across this turn's calls, newest-tail capped. */
  diff?: string
}

/** Cap per-file accumulated diff text so a runaway turn cannot bloat the SSE
 *  frame; the newest tail is kept because the latest change matters most. */
export const MAX_FILE_DIFF_CHARS = 200_000

interface PendingCall {
  name: string
  rawPath: string | null
  /** Latest diff text streamed on update frames, superseded by the end frame. */
  diff: string | null
}

export interface TurnFileState {
  pending: ReadonlyMap<string, PendingCall>
  changes: ReadonlyMap<string, ChangedFile>
}

export const emptyTurnFileState: TurnFileState = { pending: new Map(), changes: new Map() }

/** Prefix-anchored exclusions win over the stem match: `todo_write` must not
 *  count as a file write, and bash-driven changes are out of scope here. A
 *  wrongly excluded editing tool (e.g. `search_replace`) is still counted via
 *  the stronger diff-presence signal in applyToolEvent. */
const NON_MUTATING = /^(read|grep|glob|ls|list|find|search|fetch|web|browse|bash|shell|exec|run|todo|task|think|plan)/i
const MUTATING_STEM = /(edit|write|patch|create|replace|save|move|rename|delete|remove)/i

export function isMutatingToolName(name: string): boolean {
  if (NON_MUTATING.test(name)) return false
  return MUTATING_STEM.test(name)
}

/** Argument field names for the target file vary across OMP versions. */
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target_file', 'targetFile'] as const

export function extractToolFilePath(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const record = args as Record<string, unknown>
  for (const field of PATH_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** Turns an agent-reported path (absolute, or relative to OMP's cwd) into the
 *  form the UI browses with. Supplied by the caller — workspace/store.ts binds it
 *  to the live multi-root workspace — so this module stays free of process state. */
export type DisplayPathResolver = (rawPath: string) => string

/** Fallback resolver for callers without a workspace: separators only. */
export const posixDisplayPath: DisplayPathResolver = (rawPath) => rawPath.replace(/\\/g, '/')

/** Fold one normalized tool event into the turn state. A file counts as
 *  changed when its call ends with a diff (strongest signal) or the tool name
 *  is mutating; failed calls only count when they produced a diff. */
export function applyToolEvent(
  state: TurnFileState,
  event: ToolEventLike,
  resolveDisplayPath: DisplayPathResolver = posixDisplayPath
): TurnFileState {
  if (event.phase === 'start') {
    const pending = new Map(state.pending)
    pending.set(event.id, { name: event.name, rawPath: extractToolFilePath(event.args), diff: null })
    return { pending, changes: state.changes }
  }

  const known = state.pending.get(event.id)

  if (event.phase === 'update') {
    if (!event.diff) return state
    const pending = new Map(state.pending)
    // A missed start frame (listener attached mid-turn) must not lose the diff.
    pending.set(event.id, {
      name: known?.name ?? event.name,
      rawPath: known?.rawPath ?? extractToolFilePath(event.args),
      diff: event.diff
    })
    return { pending, changes: state.changes }
  }

  const pending = new Map(state.pending)
  pending.delete(event.id)
  // Fall back to the end frame's own args when the start frame was missed or
  // carried no recognizable path field.
  const rawPath = known?.rawPath ?? extractToolFilePath(event.args)
  const diffText = event.diff ?? known?.diff ?? null
  const hasDiff = diffText !== null
  const failed = event.isError === true
  const mutating = hasDiff || isMutatingToolName(event.name)
  if (!mutating || rawPath === null || (failed && !hasDiff)) {
    return { pending, changes: state.changes }
  }

  const displayPath = resolveDisplayPath(rawPath)
  const existing = state.changes.get(displayPath)
  const tools = existing
    ? existing.tools.includes(event.name) ? existing.tools : [...existing.tools, event.name]
    : [event.name]
  const mergedDiff = [existing?.diff, diffText].filter((part): part is string => Boolean(part)).join('\n')
  const cappedDiff = mergedDiff.length > MAX_FILE_DIFF_CHARS
    ? mergedDiff.slice(mergedDiff.length - MAX_FILE_DIFF_CHARS)
    : mergedDiff
  const changes = new Map(state.changes)
  changes.set(displayPath, {
    path: displayPath,
    tools,
    lastToolCallId: event.id,
    hasDiff: (existing?.hasDiff ?? false) || hasDiff,
    isError: failed,
    ...(cappedDiff ? { diff: cappedDiff } : {})
  })
  return { pending, changes }
}

export function listChangedFiles(state: TurnFileState): ChangedFile[] {
  return [...state.changes.values()]
}
