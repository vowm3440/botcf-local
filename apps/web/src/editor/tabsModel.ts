/** Pure model for the editor's multi-tab state.
 *
 *  `paths` is the visible tab order (workdir-relative file paths) and
 *  `activePath` is the focused tab — both persisted, so a reload restores the
 *  same set of open files *and* which one was in front. Every operation returns
 *  a new state; nothing here touches storage or the DOM. */

export interface TabsState {
  paths: string[]
  activePath: string | null
}

export interface OpenTabOptions {
  /** Cap on simultaneously open tabs; the oldest evictable tab is dropped. */
  maxTabs?: number
  /** Tabs that must never be evicted (unsaved edits). */
  keep?: readonly string[]
}

export const DEFAULT_MAX_TABS = 24

export const EMPTY_TABS: TabsState = { paths: [], activePath: null }

function withActive(paths: string[], activePath: string | null): TabsState {
  if (paths.length === 0) return EMPTY_TABS
  return { paths, activePath: activePath && paths.includes(activePath) ? activePath : paths[paths.length - 1] }
}

/** Open (or focus) a path. Already-open paths keep their position — reopening a
 *  file from the tree must not shuffle the tab strip. */
export function openTab(state: TabsState, path: string, options: OpenTabOptions = {}): TabsState {
  if (!path) return state
  if (state.paths.includes(path)) {
    return state.activePath === path ? state : { ...state, activePath: path }
  }
  const maxTabs = Math.max(1, options.maxTabs ?? DEFAULT_MAX_TABS)
  const keep = new Set(options.keep ?? [])
  let paths = [...state.paths, path]
  while (paths.length > maxTabs) {
    const victim = paths.find((candidate) => candidate !== path && !keep.has(candidate))
    if (!victim) break
    paths = paths.filter((candidate) => candidate !== victim)
  }
  return { paths, activePath: path }
}

/** Close one tab; focus moves to the tab on its right, else its left. */
export function closeTab(state: TabsState, path: string): TabsState {
  const index = state.paths.indexOf(path)
  if (index < 0) return state
  const paths = state.paths.filter((candidate) => candidate !== path)
  if (paths.length === 0) return EMPTY_TABS
  if (state.activePath !== path) return { paths, activePath: state.activePath }
  return { paths, activePath: paths[Math.min(index, paths.length - 1)] }
}

export function closeOtherTabs(state: TabsState, path: string): TabsState {
  if (!state.paths.includes(path)) return state
  return { paths: [path], activePath: path }
}

export function closeAllTabs(): TabsState {
  return EMPTY_TABS
}

export function activateTab(state: TabsState, path: string): TabsState {
  if (!state.paths.includes(path) || state.activePath === path) return state
  return { ...state, activePath: path }
}

/** Step the active tab by `offset`, wrapping around (Ctrl+PageUp/PageDown). */
export function cycleTab(state: TabsState, offset: number): TabsState {
  if (state.paths.length === 0) return state
  const current = state.activePath ? state.paths.indexOf(state.activePath) : 0
  const base = current < 0 ? 0 : current
  const size = state.paths.length
  const next = (((base + offset) % size) + size) % size
  return { ...state, activePath: state.paths[next] }
}

/** Drag-reorder: place `path` before `beforePath`, or last when it is null. */
export function moveTab(state: TabsState, path: string, beforePath: string | null): TabsState {
  if (!state.paths.includes(path) || path === beforePath) return state
  const rest = state.paths.filter((candidate) => candidate !== path)
  const index = beforePath ? rest.indexOf(beforePath) : -1
  if (beforePath && index < 0) return state
  const paths = [...rest]
  paths.splice(index < 0 ? paths.length : index, 0, path)
  return { ...state, paths }
}

/** Validate a persisted value. Never throws — a corrupt entry opens no tabs. */
export function parseStoredTabs(raw: string | null): TabsState {
  if (!raw) return EMPTY_TABS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_TABS
  }
  if (!parsed || typeof parsed !== 'object') return EMPTY_TABS
  const { paths, activePath } = parsed as { paths?: unknown; activePath?: unknown }
  if (!Array.isArray(paths)) return EMPTY_TABS
  const unique: string[] = []
  for (const entry of paths) {
    if (typeof entry === 'string' && entry !== '' && !unique.includes(entry)) unique.push(entry)
  }
  return withActive(unique, typeof activePath === 'string' ? activePath : null)
}

export function serializeTabs(state: TabsState): string {
  return JSON.stringify({ paths: state.paths, activePath: state.activePath })
}
