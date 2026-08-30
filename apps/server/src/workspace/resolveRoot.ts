import { primaryRoot, rootById, rootByName, type WorkspaceRoot } from './model.js'
import { getWorkspace } from './store.js'

/** Root selection for every panel that operates on *one* project directory
 *  (git, tasks, terminal, project config, review).
 *
 *  The client may only ever name an open root — by id or by display name — never
 *  a path, so no HTTP caller can point these features at a directory the user did
 *  not add to the workspace. An omitted name resolves to the primary root, which
 *  is the agent's cwd and what a single-directory workspace always meant. */

export function resolveWorkspaceRoot(requested?: string): WorkspaceRoot | null {
  const workspace = getWorkspace()
  const wanted = (requested ?? '').trim()
  if (wanted) return rootById(workspace, wanted) ?? rootByName(workspace, wanted)
  return primaryRoot(workspace)
}

export type RootResolution =
  | { ok: true; root: WorkspaceRoot }
  | { ok: false; status: number; error: string }

export function requireWorkspaceRoot(requested?: string): RootResolution {
  if (requested !== undefined && typeof requested !== 'string') {
    return { ok: false, status: 400, error: 'root 必须是字符串' }
  }
  const root = resolveWorkspaceRoot(requested)
  if (!root) {
    return {
      ok: false,
      status: 409,
      error: requested?.trim()
        ? `工作区中没有这个目录: ${requested.trim().slice(0, 60)}`
        : '未设置工作目录,请先在文件面板添加项目目录'
    }
  }
  return { ok: true, root }
}
