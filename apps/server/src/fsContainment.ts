import fs from 'node:fs'
import path from 'node:path'

/** Workdir containment: every filesystem path that reaches the UI file panel or
 *  the live-preview host passes through here. String-level containment first,
 *  then a realpath re-check so symlinks/junctions cannot escape either.
 *  Extracted from routes/files.ts so non-route modules (preview host) can reuse
 *  it without depending on a route module. */

/** Pure string-level containment: resolve `requested` against `root`, refuse
 *  anything that escapes. Symlink escapes are caught by realpathInsideRoot. */
export function resolveInsideRoot(root: string, requested: string): string | null {
  const target = path.resolve(root, requested || '.')
  const rel = path.relative(root, target)
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return null
  return target
}

/** Containment check that collapses symlinks on both sides. Returns the real
 *  target path, or null when the path is missing or escapes the root. */
export function realpathInsideRoot(root: string, requested: string): string | null {
  const located = locateInsideRoot(root, requested)
  return located.status === 'ok' ? located.target : null
}

export type LocateResult =
  | { status: 'ok'; target: string }
  | { status: 'missing' }
  | { status: 'outside' }

/** Containment with a clear failure reason. String containment is tried first;
 *  an absolute request that fails it still passes when its realpath lands
 *  inside the workdir's realpath — the workdir may itself be a symlink or
 *  junction, and OMP reports resolved absolute paths in that case. A contained
 *  path that cannot be realpathed simply does not exist (e.g. deleted). */
export function locateInsideRoot(root: string, requested: string): LocateResult {
  const contained = resolveInsideRoot(root, requested)
  const candidate = contained ?? (path.isAbsolute(requested || '') ? path.resolve(requested) : null)
  if (!candidate) return { status: 'outside' }
  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(root)
  } catch {
    return { status: 'outside' }
  }
  let realTarget: string
  try {
    realTarget = fs.realpathSync.native(candidate)
  } catch {
    // The path does not exist. Classify by its parent directory so a deleted or
    // moved file inside the workdir reads as "missing" instead of "out of
    // bounds". The walk terminates at the drive/filesystem root.
    const parent = path.dirname(candidate)
    if (parent !== candidate && locateInsideRoot(root, parent).status !== 'outside') {
      return { status: 'missing' }
    }
    return contained ? { status: 'missing' } : { status: 'outside' }
  }
  const rel = path.relative(realRoot, realTarget)
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return { status: 'outside' }
  return { status: 'ok', target: realTarget }
}
