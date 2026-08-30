import path from 'node:path'
import {
  EMPTY_WORKSPACE,
  MAX_WORKSPACE_ROOTS,
  addRoot,
  sanitizeRootName,
  sameRootPath,
  type Workspace,
  type WorkspaceRoot
} from './model.js'

/** Sealed-blob (de)serialization for the workspace, plus migration from the
 *  single-directory `omp.workdir` secret that predates multi-root support.
 *
 *  Parsing never throws and never rejects a whole workspace over one bad entry:
 *  a corrupt or hand-edited blob degrades to the roots that still make sense, so
 *  the app always starts. Roots whose directory has since disappeared are kept
 *  on purpose — the UI marks them missing so the user can remove them
 *  deliberately, instead of them silently vanishing. */

interface StoredWorkspace {
  version: 1
  roots: WorkspaceRoot[]
  primaryId: string | null
}

export function serializeWorkspace(workspace: Workspace): string {
  const stored: StoredWorkspace = {
    version: 1,
    roots: workspace.roots.map((root) => ({ id: root.id, name: root.name, path: root.path })),
    primaryId: workspace.primaryId
  }
  return JSON.stringify(stored)
}

function readRoot(value: unknown): WorkspaceRoot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { id, name, path: dir } = value as { id?: unknown; name?: unknown; path?: unknown }
  if (typeof id !== 'string' || !id.trim()) return null
  if (typeof dir !== 'string' || !dir.trim() || !path.isAbsolute(dir)) return null
  if (typeof name !== 'string') return null
  const safeName = sanitizeRootName(name.trim())
  if (!safeName) return null
  return { id: id.trim(), name: safeName, path: path.resolve(dir) }
}

/** Keep the first occurrence of each id, name and directory: duplicates would
 *  make a qualified path ambiguous. */
function dedupeRoots(roots: readonly WorkspaceRoot[]): WorkspaceRoot[] {
  const ids = new Set<string>()
  const names = new Set<string>()
  const kept: WorkspaceRoot[] = []
  for (const root of roots) {
    const name = root.name.toLowerCase()
    if (ids.has(root.id) || names.has(name)) continue
    if (kept.some((existing) => sameRootPath(existing.path, root.path))) continue
    ids.add(root.id)
    names.add(name)
    kept.push(root)
    if (kept.length >= MAX_WORKSPACE_ROOTS) break
  }
  return kept
}

/** Restore a workspace from its sealed blob. `legacyWorkdir` is the pre-workspace
 *  `omp.workdir` value: when no workspace was ever persisted, that single
 *  directory becomes the one (primary) root, so an upgrade keeps the user's
 *  project selected. */
export function parseWorkspace(raw: string | null, legacyWorkdir?: string | null): Workspace {
  const stored = readStored(raw)
  const storedRoots = stored && Array.isArray(stored.roots) ? stored.roots : []
  const roots = dedupeRoots(storedRoots.map(readRoot).filter((root): root is WorkspaceRoot => root !== null))
  if (roots.length === 0) {
    const legacy = (legacyWorkdir ?? '').trim()
    if (!legacy) return EMPTY_WORKSPACE
    const migrated = addRoot(EMPTY_WORKSPACE, { path: legacy })
    return migrated.ok ? migrated.workspace : EMPTY_WORKSPACE
  }
  const storedPrimary = stored && typeof stored.primaryId === 'string' ? stored.primaryId : null
  const primaryId = storedPrimary && roots.some((root) => root.id === storedPrimary) ? storedPrimary : roots[0].id
  return { roots, primaryId }
}

function readStored(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
