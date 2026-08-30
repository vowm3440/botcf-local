import type { WorkspaceRootInfo } from '../api'
import { getJson, postJson, query } from './http'
import type { ShellKind } from './terminal'
import type { TaskKind } from './tasks'

/** Project-level config client (`<root>/.botcf/config.json`).
 *
 *  Saving returns the *normalized* config plus the validation warnings, so the
 *  panel can show exactly which entries the server rejected instead of pretending
 *  everything was stored. */

export interface ProjectTaskConfig {
  name: string
  kind: TaskKind
  script?: string
  command?: string[]
  cwd?: string
  env?: Record<string, string>
  background?: boolean
}

export interface ProjectConfig {
  version: 1
  tasks: ProjectTaskConfig[]
  discoverScripts: boolean
  preview: { mode: 'auto' | 'static' | 'command'; script: string | null }
  terminal: { shell: ShellKind | null; env: Record<string, string> }
  review: { stageOnAccept: boolean; commitTemplate: string }
}

export interface ProjectConfigResponse {
  success: boolean
  root: { id: string; name: string; path: string }
  roots: WorkspaceRootInfo[]
  file: string
  exists: boolean
  config: ProjectConfig
  warnings: string[]
  /** Raw file text, for the "edit as JSON" mode. */
  text: string | null
  mtimeMs: number | null
  defaults: ProjectConfig
  taskKinds: TaskKind[]
  shellKinds: ShellKind[]
  platformShell: ShellKind
  created?: boolean
}

export const projectConfigApi = {
  load: (root?: string) => getJson<ProjectConfigResponse>(`/api/project-config${query({ root })}`),

  save: (payload: { root?: string; config?: ProjectConfig; text?: string }) =>
    postJson<ProjectConfigResponse>('/api/project-config', payload),

  init: (root?: string) => postJson<ProjectConfigResponse>('/api/project-config/init', { root })
}
