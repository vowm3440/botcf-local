import fs from 'node:fs'
import path from 'node:path'
import { locateInsideRoot } from '../fsContainment.js'
import {
  findRootForPath,
  normalizeWorkspacePath,
  rootByName,
  splitWorkspacePath,
  type Workspace,
  type WorkspaceRoot
} from './model.js'

/** Resolve a qualified workspace path (`<rootName>/<relative>`) to a real file.
 *
 *  This is the single funnel every filesystem request from the UI passes through
 *  once a workspace can hold several roots. The root name selects the root; the
 *  remainder is contained inside it by fsContainment (string containment plus a
 *  realpath re-check), so neither `..` nor a symlink can use one root as a bridge
 *  out of the workspace — or into a directory that merely happens to sit next to
 *  another root.
 *
 *  Two non-qualified forms are accepted, because paths do not only come from our
 *  own UI:
 *   - an absolute path, which is what OMP reports for the files it touched; it
 *     must land inside some root;
 *   - a plain relative path, but only in a single-root workspace, so pre-existing
 *     editor tabs and bookmarks keep working after the upgrade. With several
 *     roots such a path is genuinely ambiguous and is refused. */

export type WorkspaceLocation =
  /** The workspace pseudo-root: the list of roots, not a directory on disk. */
  | { status: 'workspace' }
  | { status: 'ok'; root: WorkspaceRoot; relative: string; target: string }
  /** Inside a known root, but nothing is there (moved or deleted). */
  | { status: 'missing'; root: WorkspaceRoot }
  | { status: 'outside' }

/** Root-relative POSIX path for a resolved target. Derived from the *collapsed*
 *  root, so a junction root and a `..` inside the request both report the path
 *  the file actually has. */
function relativeFromTarget(root: WorkspaceRoot, target: string): string {
  let base = root.path
  try {
    base = fs.realpathSync.native(root.path)
  } catch {
    // Root directory vanished — fall back to the configured path.
  }
  return path.relative(base, target).replace(/\\/g, '/')
}

function locateInRoot(root: WorkspaceRoot, relative: string): WorkspaceLocation {
  const located = locateInsideRoot(root.path, relative || '.')
  if (located.status === 'ok') {
    return { status: 'ok', root, relative: relativeFromTarget(root, located.target), target: located.target }
  }
  if (located.status === 'missing') {
    return { status: 'missing', root }
  }
  return { status: 'outside' }
}

export function locateWorkspacePath(workspace: Workspace, requested: string): WorkspaceLocation {
  const raw = (requested ?? '').trim()
  const normalized = normalizeWorkspacePath(raw)
  if (normalized === '') return { status: 'workspace' }

  // OMP reports absolute paths; attribute them to the most specific root.
  if (path.isAbsolute(raw)) {
    const owner = findRootForPath(workspace, raw)
    if (owner) return locateInRoot(owner.root, owner.relative)
    // The root itself may be a symlink/junction, so string containment can fail
    // for a path that really does live inside it. Let each root's realpath check
    // have a say before calling it out of bounds.
    let missing: WorkspaceLocation | null = null
    for (const root of workspace.roots) {
      const located = locateInsideRoot(root.path, raw)
      if (located.status === 'ok') {
        return { status: 'ok', root, relative: relativeFromTarget(root, located.target), target: located.target }
      }
      if (located.status === 'missing' && !missing) {
        missing = { status: 'missing', root }
      }
    }
    return missing ?? { status: 'outside' }
  }

  const { head, rest } = splitWorkspacePath(normalized)
  const named = rootByName(workspace, head)
  if (named) return locateInRoot(named, rest)

  // Legacy unqualified path: unambiguous only while a single root is open.
  if (workspace.roots.length === 1) return locateInRoot(workspace.roots[0], normalized)
  return { status: 'outside' }
}

/** Wire shape for a root: the model plus the two facts only the filesystem and
 *  the workspace as a whole can answer. A root whose directory disappeared stays
 *  listed (flagged `exists: false`) so the user can remove it deliberately. */
export interface WorkspaceRootInfo {
  id: string
  name: string
  path: string
  exists: boolean
  primary: boolean
}

export function workspaceRootInfos(workspace: Workspace): WorkspaceRootInfo[] {
  return workspace.roots.map((root) => ({
    id: root.id,
    name: root.name,
    path: root.path,
    exists: directoryExists(root.path),
    primary: root.id === workspace.primaryId
  }))
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
