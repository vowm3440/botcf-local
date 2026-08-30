import fs from 'node:fs'
import { restartRuntime, type RuntimeRestart } from '../omp/runtime.js'
import { previewManager } from '../preview/manager.js'
import { taskManager } from '../tasks/manager.js'
import { terminalRegistry } from '../terminal/registry.js'
import {
  addRoot,
  primaryRoot,
  removeRoot,
  rootById,
  sameRootPath,
  setPrimaryRoot,
  type Workspace,
  type WorkspaceRoot
} from './model.js'
import { getWorkspace, setWorkspace } from './store.js'

/** Workspace mutations with their runtime consequences.
 *
 *  Two side effects matter, and only when the *primary* root changes:
 *   - OMP takes its cwd when the process spawns (the RPC contract has no cwd
 *     command), so a new primary root means a restart of the agent process;
 *   - the live preview would otherwise keep serving the previous project — and in
 *     command mode keep that project's dev server alive.
 *
 *  Adding or removing a secondary root is deliberately cheap: it changes what the
 *  file panel and the editor can reach, and must never interrupt a running turn.
 *  Everything *bound to a directory* is released when that directory leaves the
 *  workspace, even a secondary one: the preview, running tasks and terminal
 *  sessions all hold child processes with that directory as their cwd. */

export interface WorkspaceMutation {
  ok: true
  workspace: Workspace
  root: WorkspaceRoot | null
  /** False when the requested directory was already a root (idempotent add). */
  added: boolean
  /** True only when OMP came back *and* is carrying the active route again. */
  restarted: boolean
  /** Why the runtime could not be brought back; null when nothing went wrong.
   *  The workspace change itself still applied — the agent is in direct mode. */
  runtimeError: string | null
}

export type WorkspaceMutationResult = WorkspaceMutation | { ok: false; status: number; error: string }

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync.native(dir)
  } catch {
    return dir
  }
}

/** Root already covering `dir`, comparing collapsed paths so a junction and its
 *  target are not opened as two roots with identical content. */
function rootCovering(workspace: Workspace, dir: string): WorkspaceRoot | null {
  const real = realpathOrSelf(dir)
  return workspace.roots.find((root) => sameRootPath(realpathOrSelf(root.path), real)) ?? null
}

/** Restart the agent runtime so it observes the new primary root as its cwd.
 *
 *  Goes through the shared entry point in omp/runtime.ts, which also re-applies
 *  and verifies the active route: OMP restores its own persisted model on start,
 *  and a primary-root switch that skipped that step left the UI showing one route
 *  while the agent used another. */
async function reactivateRuntime(): Promise<RuntimeRestart> {
  await previewManager.stop().catch(() => undefined)
  return restartRuntime()
}

async function stopPreviewForRoot(root: WorkspaceRoot): Promise<void> {
  const hosted = previewManager.getState().workdir
  if (hosted && sameRootPath(hosted, root.path)) {
    await previewManager.stop().catch(() => undefined)
  }
}

/** Apply a workspace whose primary root differs from the current one. */
async function commitWithRestart(next: Workspace, root: WorkspaceRoot | null, added: boolean): Promise<WorkspaceMutation> {
  const before = primaryRoot(getWorkspace())?.id ?? null
  setWorkspace(next)
  const after = next.primaryId
  const outcome = before === after ? null : await reactivateRuntime()
  return {
    ok: true,
    workspace: next,
    root,
    added,
    restarted: outcome !== null && outcome.status === 'restarted',
    runtimeError: outcome !== null && outcome.status === 'failed' ? outcome.error : null
  }
}

export async function addRootToWorkspace(input: { path: string; name?: string; primary?: boolean }): Promise<WorkspaceMutationResult> {
  const requested = (input.path ?? '').trim()
  if (!requested) return { ok: false, status: 400, error: '缺少目录路径' }
  if (!directoryExists(requested)) return { ok: false, status: 400, error: `目录不存在: ${requested}` }

  const workspace = getWorkspace()
  const covering = rootCovering(workspace, requested)
  const base = covering
    ? { ok: true as const, workspace, root: covering, added: false }
    : addRoot(workspace, { path: requested, ...(input.name ? { name: input.name } : {}) })
  if (!base.ok) return { ok: false, status: 400, error: base.error }

  const wantsPrimary = input.primary === true || workspace.roots.length === 0
  const next = wantsPrimary ? setPrimaryRoot(base.workspace, base.root.id) : base.workspace
  return commitWithRestart(next, base.root, base.added)
}

export async function removeRootFromWorkspace(id: string): Promise<WorkspaceMutationResult> {
  const workspace = getWorkspace()
  const root = rootById(workspace, id)
  if (!root) return { ok: false, status: 404, error: '工作区中没有这个目录' }
  await stopPreviewForRoot(root)
  // Tasks and shells hold this directory as their cwd; on Windows an open cwd
  // even blocks deleting or moving it afterwards.
  await taskManager.stopForRoot(root.id).catch(() => 0)
  await terminalRegistry.closeForRoot(root.id).catch(() => 0)
  return commitWithRestart(removeRoot(workspace, id), root, false)
}

export async function setPrimaryWorkspaceRoot(id: string): Promise<WorkspaceMutationResult> {
  const workspace = getWorkspace()
  const root = rootById(workspace, id)
  if (!root) return { ok: false, status: 404, error: '工作区中没有这个目录' }
  if (!directoryExists(root.path)) return { ok: false, status: 400, error: `目录不存在: ${root.path}` }
  return commitWithRestart(setPrimaryRoot(workspace, id), root, false)
}
