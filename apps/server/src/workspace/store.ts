import { getSecret, putSecret } from '../db.js'
import { open, seal } from '../secure/store.js'
import { EMPTY_WORKSPACE, workspaceDisplayPath, type Workspace } from './model.js'
import { rootRuntime } from './rootRuntime.js'
import { parseWorkspace, serializeWorkspace } from './serialize.js'

/** Process-wide holder for the active workspace, plus its sealed persistence.
 *
 *  The workspace value itself is immutable (workspace/model.ts); this module owns
 *  the single mutable reference to the current one, mirrors it into the encrypted
 *  store, and tells the per-root runtime controller (workspace/rootRuntime.ts)
 *  which roots are live and which one is primary. Every root now owns its own
 *  OMP client/cwd, so rpc.ts never needs to know a workspace exists. */

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

/** Replace the workspace, persist it, and reconcile the per-root runtime
 *  controller (roots added/removed, primary focus changed). Starting or
 *  stopping OMP processes is the caller's decision — adding a secondary root
 *  must not interrupt a running agent. */
export function setWorkspace(next: Workspace): Workspace {
  current = next
  putSecret(WORKSPACE_SECRET, seal(serializeWorkspace(next)))
  rootRuntime.syncWorkspace(next)
  return current
}

/** Load the persisted workspace at startup, migrating the legacy `omp.workdir`
 *  secret into a single-root workspace when no workspace was ever saved. */
export function restoreWorkspace(): Workspace {
  current = parseWorkspace(readSecret(WORKSPACE_SECRET), readSecret(LEGACY_WORKDIR_SECRET))
  rootRuntime.syncWorkspace(current)
  return current
}

/** Resolver for agent-reported paths, bound to the live workspace. */
export function displayPathInWorkspace(rawPath: string): string {
  return workspaceDisplayPath(current, rawPath)
}
