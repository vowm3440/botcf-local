/**
 * Pure per-root runtime state machine (docs/lightweight-ide-resource-plan.md §3).
 *
 * Runtime state is deliberately NOT persisted: every boot starts cold and this
 * module only records what the app would keep alive right now, so the OMP pool
 * and the UI agree on one story per root. Each root moves along:
 *
 *   cold ──(user activates: makes it primary / opens chat on it)──> restoring ──> active
 *   active ──(another root took focus)──> background ──(idle ≥ N, unpinned, not busy)──> cold
 *   any ──(root removed)──> closed   (entry dropped, recovery log kept)
 *
 * `restoring` is the "正在恢复" badge: requestActivate() enters it from cold,
 * markActive() completes it and markRestoreFailed() returns it to cold. A root
 * is never auto-colded while it is pinned, busy (running task / preview / AI
 * turn) or still inside its idle window.
 *
 * The module is pure: no timers, no processes. `release(rootId)` in the plan is
 * implemented by each resource owner; this module only decides the order in
 * which they run and records the outcome.
 */
export type RootRuntimeStatus = 'cold' | 'restoring' | 'active' | 'background'

/** The order every owner follows when a root is released (plan §3). Each module
 *  that holds per-root resources implements the same contract: stop new
 *  requests, cancel in-flight work, persist, then drop references and kill the
 *  process tree last so nothing can re-acquire mid-release. */
export const RELEASE_ORDER = [
  'stop-new-requests',
  'cancel-in-flight',
  'save-state',
  'close-subscriptions',
  'destroy-views',
  'kill-tree',
  'drop-cache-references'
] as const

export type ReleaseStep = (typeof RELEASE_ORDER)[number]

export interface RootRuntimeEntry {
  rootId: string
  status: RootRuntimeStatus
  /** User pinned the root: it is never auto-reaped to cold. */
  pinned: boolean
  /** Running task / preview / in-flight AI turn pins the root in place too. */
  busy: boolean
  /** Clock value of the last completed activation, or null before any. */
  lastActiveAt: number | null
  /** Clock value of the most recent active → background transition. */
  backgroundSince: number | null
}

export interface ClosedRootLogEntry {
  rootId: string
  closedAt: number
}

export interface RuntimeStates {
  entries: RootRuntimeEntry[]
  /** Closed-root recovery log: kept (not persisted) so the UI can show what was
   *  released, capped so it cannot grow without bound. */
  closedLog: ClosedRootLogEntry[]
}

/** Default idle window before a background root is allowed to go cold. */
export const DEFAULT_IDLE_COLD_MS = 5 * 60_000

export const MAX_RECOVERY_LOG = 64

export function createRuntimeStates(): RuntimeStates {
  return { entries: [], closedLog: [] }
}

export function getRoot(states: RuntimeStates, rootId: string): RootRuntimeEntry | null {
  return states.entries.find((entry) => entry.rootId === rootId) ?? null
}

function withEntry(states: RuntimeStates, rootId: string, patch: Partial<RootRuntimeEntry>): RuntimeStates {
  const current = getRoot(states, rootId)
  if (!current) return states
  return {
    ...states,
    entries: states.entries.map((entry) => (entry.rootId === rootId ? { ...entry, ...patch } : entry))
  }
}

/** Make sure every workspace root has a state entry (cold when absent). */
export function registerRoot(states: RuntimeStates, rootId: string): RuntimeStates {
  if (getRoot(states, rootId)) return states
  return {
    ...states,
    entries: [...states.entries, { rootId, status: 'cold', pinned: false, busy: false, lastActiveAt: null, backgroundSince: null }]
  }
}

/** Drop entries for roots that left the workspace, log them as closed, and
 *  register (cold) any root that is new. */
export function reconcileRoots(states: RuntimeStates, liveRootIds: readonly string[], now: number): RuntimeStates {
  let next = states
  const live = new Set(liveRootIds)
  for (const entry of states.entries) {
    if (!live.has(entry.rootId)) next = closeRoot(next, entry.rootId, now)
  }
  for (const rootId of liveRootIds) {
    if (!getRoot(next, rootId)) next = registerRoot(next, rootId)
  }
  return next
}
/** User activates a root (makes it primary / opens chat on it): cold and
 *  background both route through `restoring` so the UI can show 恢复中 while the
 *  runtime comes back. Active roots stay active. */
export function requestActivate(states: RuntimeStates, rootId: string): RuntimeStates {
  const current = getRoot(states, rootId)
  if (!current) return states
  if (current.status === 'active' || current.status === 'restoring') return states
  return withEntry(states, rootId, { status: 'restoring', backgroundSince: null })
}

/** The runtime handshake finished (or direct mode was accepted) for a root that
 *  was being restored. */
export function markActive(states: RuntimeStates, rootId: string, now: number): RuntimeStates {
  const current = getRoot(states, rootId)
  if (!current) return states
  if (current.status === 'active') return states
  return withEntry(states, rootId, { status: 'active', lastActiveAt: now, backgroundSince: null })
}

/** The runtime could not be restored; the root drops back to cold. */
export function markRestoreFailed(states: RuntimeStates, rootId: string): RuntimeStates {
  const current = getRoot(states, rootId)
  if (!current || current.status !== 'restoring') return states
  return withEntry(states, rootId, { status: 'cold', backgroundSince: null })
}

/** Focus left the root: active/restoring → background, starting its idle clock. */
export function background(states: RuntimeStates, rootId: string, now: number): RuntimeStates {
  const current = getRoot(states, rootId)
  if (!current) return states
  if (current.status !== 'active' && current.status !== 'restoring') return states
  return withEntry(states, rootId, { status: 'background', backgroundSince: now })
}

export function setPinned(states: RuntimeStates, rootId: string, pinned: boolean): RuntimeStates {
  const current = getRoot(states, rootId)
  if (!current || current.pinned === pinned) return states
  return withEntry(states, rootId, { pinned })
}

/** Mark a root as holding in-flight work (running task/preview/AI). Busy roots
 *  are not eligible for auto-cold, mirroring pin for short-lived work. */
export function setBusy(states: RuntimeStates, rootId: string, busy: boolean): RuntimeStates {
  const current = getRoot(states, rootId)
  if (!current || current.busy === busy) return states
  return withEntry(states, rootId, { busy })
}

/** Background roots that may go cold right now: idle ≥ `idleMs`, unpinned and
 *  not busy. Returned oldest-first so a reap loop frees the longest-idle root
 *  first. */
export function idleReapCandidates(states: RuntimeStates, now: number, idleMs: number = DEFAULT_IDLE_COLD_MS): RootRuntimeEntry[] {
  return states.entries
    .filter(
      (entry) =>
        entry.status === 'background'
        && !entry.pinned
        && !entry.busy
        && entry.backgroundSince !== null
        && now - entry.backgroundSince >= idleMs
    )
    .sort((a, b) => (a.backgroundSince ?? 0) - (b.backgroundSince ?? 0))
}

/** background → cold; clears the idle clock. No-op for any other status. */
export function reapToCold(states: RuntimeStates, rootId: string): RuntimeStates {
  const current = getRoot(states, rootId)
  if (!current || current.status !== 'background') return states
  return withEntry(states, rootId, { status: 'cold', backgroundSince: null })
}

/** Any status → closed: the entry leaves the map (its resources are released)
 *  and the root lands in the recovery log. */
export function closeRoot(states: RuntimeStates, rootId: string, now: number): RuntimeStates {
  if (!getRoot(states, rootId)) return states
  return {
    ...states,
    entries: states.entries.filter((entry) => entry.rootId !== rootId),
    closedLog: [...states.closedLog, { rootId, closedAt: now }].slice(-MAX_RECOVERY_LOG)
  }
}
