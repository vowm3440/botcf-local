import path from 'node:path'

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
  /** Workdir-relative POSIX path when inside the workdir, absolute otherwise. */
  path: string
  /** Mutating tool names that touched the file, in first-seen order. */
  tools: string[]
  /** Latest mutating tool call — the UI anchors "jump to diff" on it. */
  lastToolCallId: string
  hasDiff: boolean
  /** True when the latest mutating call on this file ended in error. */
  isError: boolean
}

interface PendingCall {
  name: string
  rawPath: string | null
  hasDiff: boolean
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

/** Normalize a tool-reported path for display and dedup: resolve against the
 *  workdir, prefer a relative POSIX form, keep out-of-workdir paths absolute. */
export function toDisplayPath(rawPath: string, workdir: string | null): string {
  const posix = (p: string): string => p.replace(/\\/g, '/')
  if (!workdir) return posix(rawPath)
  const resolved = path.resolve(workdir, rawPath)
  const rel = path.relative(workdir, resolved)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return posix(resolved)
  return posix(rel)
}

/** Fold one normalized tool event into the turn state. A file counts as
 *  changed when its call ends with a diff (strongest signal) or the tool name
 *  is mutating; failed calls only count when they produced a diff. */
export function applyToolEvent(state: TurnFileState, event: ToolEventLike, workdir: string | null): TurnFileState {
  if (event.phase === 'start') {
    const pending = new Map(state.pending)
    pending.set(event.id, { name: event.name, rawPath: extractToolFilePath(event.args), hasDiff: false })
    return { pending, changes: state.changes }
  }

  const known = state.pending.get(event.id)

  if (event.phase === 'update') {
    if (!event.diff || !known || known.hasDiff) return state
    const pending = new Map(state.pending)
    pending.set(event.id, { ...known, hasDiff: true })
    return { pending, changes: state.changes }
  }

  const pending = new Map(state.pending)
  pending.delete(event.id)
  const rawPath = known?.rawPath ?? null
  const hasDiff = Boolean(event.diff) || (known?.hasDiff ?? false)
  const failed = event.isError === true
  const mutating = hasDiff || isMutatingToolName(event.name)
  if (!known || !mutating || rawPath === null || (failed && !hasDiff)) {
    return { pending, changes: state.changes }
  }

  const displayPath = toDisplayPath(rawPath, workdir)
  const existing = state.changes.get(displayPath)
  const tools = existing
    ? existing.tools.includes(event.name) ? existing.tools : [...existing.tools, event.name]
    : [event.name]
  const changes = new Map(state.changes)
  changes.set(displayPath, {
    path: displayPath,
    tools,
    lastToolCallId: event.id,
    hasDiff: (existing?.hasDiff ?? false) || hasDiff,
    isError: failed
  })
  return { pending, changes }
}

export function listChangedFiles(state: TurnFileState): ChangedFile[] {
  return [...state.changes.values()]
}
