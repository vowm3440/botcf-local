import crypto from 'node:crypto'
import path from 'node:path'

/** Multi-root workspace model.
 *
 *  A workspace is an ordered set of project directories ("roots") plus a pointer
 *  to the primary one. Every path the UI and the file APIs exchange is a
 *  *qualified workspace path* — `<rootName>/<relative>` — so a single string
 *  stays unambiguous no matter how many roots are open; the workspace itself is
 *  the empty string, and a path outside every root stays absolute.
 *
 *  Root names are unique (case-insensitively) and derived from the directory
 *  name, because they are the leading segment of every qualified path. There is
 *  deliberately no rename: a name change would invalidate every open editor tab
 *  and every recorded changed-file path.
 *
 *  Everything here is pure and immutable — no filesystem, no process state — so
 *  the rules stay unit-testable. Existence checks and containment live in
 *  locate.ts, persistence in serialize.ts/store.ts. */

export interface WorkspaceRoot {
  /** Stable id derived from the directory path, so re-adding a root reuses it. */
  readonly id: string
  /** Unique display name; the leading segment of qualified paths in this root. */
  readonly name: string
  /** Absolute directory path on disk. */
  readonly path: string
}

export interface Workspace {
  readonly roots: readonly WorkspaceRoot[]
  /** Root that provides OMP's cwd; null only while the workspace is empty. */
  readonly primaryId: string | null
}

export const EMPTY_WORKSPACE: Workspace = { roots: [], primaryId: null }

/** Cap on open roots. Each root is a watch target and a browsable tree, and the
 *  agent can only ever have one cwd — a large workspace buys confusion, not
 *  capability. */
export const MAX_WORKSPACE_ROOTS = 8

/** Characters that cannot appear in a root name: path separators plus the
 *  Windows-reserved set, since a name is used as a path segment. */
const INVALID_NAME_CHARS = /[/\\:*?"<>|\u0000-\u001f]/g

export function sanitizeRootName(raw: string): string {
  const replaced = raw.replace(INVALID_NAME_CHARS, '-')
  // Trailing dots/spaces are illegal on Windows; leading/trailing dashes are
  // just noise left behind by the replacement above.
  return replaced.replace(/^[-.\s]+/, '').replace(/[-.\s]+$/, '')
}

/** Display name for a directory: its own name, falling back to the volume label
 *  for a bare drive/filesystem root (`D:\` has no basename). */
export function deriveRootName(dir: string): string {
  const trimmed = dir.trim()
  const fromBase = sanitizeRootName(path.basename(trimmed))
  if (fromBase) return fromBase
  return sanitizeRootName(trimmed) || 'root'
}

/** First free variant of `base`, comparing case-insensitively because two roots
 *  differing only in case would be indistinguishable in a path. */
export function uniqueRootName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/** Canonical form used for identity and de-duplication. Windows paths are
 *  case-insensitive, so the same directory must hash to the same id. */
function canonicalRootPath(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function rootIdFor(dir: string): string {
  return `r${crypto.createHash('sha1').update(canonicalRootPath(dir)).digest('hex').slice(0, 10)}`
}

/** True when both paths denote the same directory (separator- and, on Windows,
 *  case-insensitive). Symlinks are collapsed by the caller, not here. */
export function sameRootPath(a: string, b: string): boolean {
  return path.relative(a, b) === ''
}

export function rootById(workspace: Workspace, id: string): WorkspaceRoot | null {
  return workspace.roots.find((root) => root.id === id) ?? null
}

/** Exact match first, then case-insensitive — a hand-typed root name should
 *  still resolve on a case-insensitive filesystem. */
export function rootByName(workspace: Workspace, name: string): WorkspaceRoot | null {
  const exact = workspace.roots.find((root) => root.name === name)
  if (exact) return exact
  const lowered = name.toLowerCase()
  return workspace.roots.find((root) => root.name.toLowerCase() === lowered) ?? null
}

export function rootByPath(workspace: Workspace, dir: string): WorkspaceRoot | null {
  return workspace.roots.find((root) => sameRootPath(root.path, dir)) ?? null
}

export function primaryRoot(workspace: Workspace): WorkspaceRoot | null {
  return workspace.primaryId ? rootById(workspace, workspace.primaryId) : null
}

export type AddRootResult =
  | { ok: true; workspace: Workspace; root: WorkspaceRoot; added: boolean }
  | { ok: false; error: string }

/** Add a directory as a root. Idempotent: an already-open directory returns the
 *  existing root with `added: false`. The first root becomes primary. */
export function addRoot(workspace: Workspace, input: { path: string; name?: string }): AddRootResult {
  const raw = (input.path ?? '').trim()
  if (!raw) return { ok: false, error: '缺少目录路径' }
  if (!path.isAbsolute(raw)) return { ok: false, error: `目录路径必须是绝对路径: ${raw}` }
  const dir = path.resolve(raw)

  const existing = rootByPath(workspace, dir)
  if (existing) return { ok: true, workspace, root: existing, added: false }
  if (workspace.roots.length >= MAX_WORKSPACE_ROOTS) {
    return { ok: false, error: `工作区最多 ${MAX_WORKSPACE_ROOTS} 个目录,请先移除一个` }
  }

  const requested = input.name?.trim() ? sanitizeRootName(input.name.trim()) : ''
  const base = requested || deriveRootName(dir)
  const root: WorkspaceRoot = {
    id: rootIdFor(dir),
    name: uniqueRootName(base, workspace.roots.map((entry) => entry.name)),
    path: dir
  }
  return {
    ok: true,
    added: true,
    root,
    workspace: {
      roots: [...workspace.roots, root],
      primaryId: workspace.primaryId ?? root.id
    }
  }
}

/** Remove a root. The primary marker moves to the first remaining root, so a
 *  non-empty workspace always has a cwd to give OMP. */
export function removeRoot(workspace: Workspace, id: string): Workspace {
  if (!rootById(workspace, id)) return workspace
  const roots = workspace.roots.filter((root) => root.id !== id)
  if (roots.length === 0) return EMPTY_WORKSPACE
  return { roots, primaryId: workspace.primaryId === id ? roots[0].id : workspace.primaryId }
}

export function setPrimaryRoot(workspace: Workspace, id: string): Workspace {
  if (workspace.primaryId === id || !rootById(workspace, id)) return workspace
  return { roots: workspace.roots, primaryId: id }
}

const toPosix = (value: string): string => value.replace(/\\/g, '/')

/** Collapse a requested path into its canonical qualified form: POSIX
 *  separators, no empty or `.` segments, no leading/trailing slash or surrounding
 *  whitespace. Parent (`..`) segments survive on purpose — containment, not
 *  normalization, rejects them. */
export function normalizeWorkspacePath(requested: string): string {
  return toPosix((requested ?? '').trim())
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

/** Split a qualified path into its leading root-name segment and the remainder. */
export function splitWorkspacePath(requested: string): { head: string; rest: string } {
  const segments = normalizeWorkspacePath(requested).split('/').filter(Boolean)
  return { head: segments[0] ?? '', rest: segments.slice(1).join('/') }
}

export function formatWorkspacePath(rootName: string, relative: string): string {
  const rel = normalizeWorkspacePath(relative)
  return rel ? `${rootName}/${rel}` : rootName
}

/** Locate the root that owns an absolute path, string-level only. Nested roots
 *  resolve to the most specific one, so a monorepo package opened as its own
 *  root wins over its parent. */
export function findRootForPath(workspace: Workspace, target: string): { root: WorkspaceRoot; relative: string } | null {
  const absolute = path.resolve(target)
  let best: { root: WorkspaceRoot; relative: string } | null = null
  let bestLength = -1
  for (const root of workspace.roots) {
    const relative = path.relative(root.path, absolute)
    if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) continue
    if (root.path.length > bestLength) {
      best = { root, relative: toPosix(relative) }
      bestLength = root.path.length
    }
  }
  return best
}

/** Display/wire form for a path reported by the agent: qualified when it lands
 *  inside a root, absolute POSIX when it does not. Relative input is resolved
 *  against the primary root, which is OMP's cwd. */
export function workspaceDisplayPath(workspace: Workspace, rawPath: string): string {
  if (workspace.roots.length === 0) return toPosix(rawPath)
  const base = primaryRoot(workspace)?.path
  const absolute = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : base
      ? path.resolve(base, rawPath)
      : null
  if (!absolute) return toPosix(rawPath)
  const found = findRootForPath(workspace, absolute)
  return found ? formatWorkspacePath(found.root.name, found.relative) : toPosix(absolute)
}
