import { getSecret, putSecret } from '../db.js'
import { ompClient } from '../omp/rpc.js'
import { open, seal } from '../secure/store.js'
import { EMPTY_WORKSPACE, primaryRoot, workspaceDisplayPath, type Workspace } from './model.js'
import { parseWorkspace, serializeWorkspace } from './serialize.js'

/** Process-wide holder for the active workspace, plus its sealed persistence.
 *
 *  The workspace value itself is immutable (workspace/model.ts); this module owns
 *  the single mutable reference to the current one, mirrors it into the encrypted
 *  store, and keeps `ompClient.workdir` pointed at the primary root — the RPC
 *  client applies that as the agent's cwd on its next start, so rpc.ts never
 *  needs to know a workspace exists. */

const WORKSPACE_SECRET = 'omp.workspace'
/** Pre-multi-root single directory; read once for migration, never written. */
const LEGACY_WORKDIR_SECRET = 'omp.workdir'

let current: Workspace = EMPTY_WORKSPACE

export function getWorkspace(): Workspace {
  return current
}

function readSecret(key: string): string | null {
  const sealed = getSecret(key)
  if (!sealed) return null
  try {
    return open(sealed)
  } catch {
    // Corrupt or foreign-keyed entry — treat it as absent rather than failing
    // startup over a directory list.
    return null
  }
}

function syncOmpWorkdir(workspace: Workspace): void {
  ompClient.workdir = primaryRoot(workspace)?.path ?? null
}

/** Replace the workspace, persist it, and re-point OMP's cwd. Restarting OMP so
 *  the new cwd takes effect is the caller's decision (workspace/activate.ts) —
 *  adding a secondary root must not interrupt a running agent. */
export function setWorkspace(next: Workspace): Workspace {
  current = next
  putSecret(WORKSPACE_SECRET, seal(serializeWorkspace(next)))
  syncOmpWorkdir(next)
  return current
}

/** Load the persisted workspace at startup, migrating the legacy `omp.workdir`
 *  secret into a single-root workspace when no workspace was ever saved. */
export function restoreWorkspace(): Workspace {
  current = parseWorkspace(readSecret(WORKSPACE_SECRET), readSecret(LEGACY_WORKDIR_SECRET))
  syncOmpWorkdir(current)
  return current
}

/** Resolver for agent-reported paths, bound to the live workspace. */
export function displayPathInWorkspace(rawPath: string): string {
  return workspaceDisplayPath(current, rawPath)
}
