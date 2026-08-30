import type { WorkspaceRootInfo } from '../api'
import { getJson, postJson, query } from './http'

/** Unified build/run/test client.
 *
 *  Tasks are derived server-side from `.botcf/config.json` plus the project's
 *  package.json scripts; the panel starts one by id and follows its run over SSE.
 *  A run's log is a ring buffer with monotonic `seq`, same contract as the
 *  terminal, so reconnecting resumes cleanly. */

export type TaskKind = 'build' | 'run' | 'test' | 'lint' | 'custom'

export type TaskRunState = 'running' | 'succeeded' | 'failed' | 'stopped'

export interface TaskRunInfo {
  id: string
  taskId: string
  taskName: string
  rootId: string
  rootName: string
  commandLine: string
  cwd: string
  background: boolean
  state: TaskRunState
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  durationMs: number
  lastSeq: number
  problemCount: number
}

export interface TaskLogLine {
  seq: number
  at: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface TaskInfo {
  id: string
  name: string
  kind: TaskKind
  source: 'config' | 'script'
  commandLine: string
  cwd: string
  background: boolean
  /** Most recent run: live while running, then the verdict it ended with. */
  run: TaskRunInfo | null
}

export interface TaskListResponse {
  success: boolean
  root: { id: string; name: string }
  roots: WorkspaceRootInfo[]
  packageManager: string
  /** Validation notes from `.botcf/config.json`. */
  configWarnings: string[]
  tasks: TaskInfo[]
  groups: Array<{ kind: TaskKind; taskIds: string[] }>
  runs: TaskRunInfo[]
}

export interface TaskRunResponse {
  success: boolean
  run: TaskRunInfo
  lines: TaskLogLine[]
}

export type TaskEvent =
  | { type: 'task_runs'; runs: TaskRunInfo[] }
  | { type: 'task_line'; runId: string; line: TaskLogLine }
  | { type: 'task_end'; run: TaskRunInfo }

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  build: '构建',
  run: '运行',
  test: '测试',
  lint: '检查',
  custom: '其他'
}

export const tasksApi = {
  list: (root?: string) => getJson<TaskListResponse>(`/api/tasks${query({ root })}`),

  run: (payload: { root?: string; taskId: string }) => postJson<TaskRunResponse>('/api/tasks/run', payload),

  stop: (runId: string) => postJson<{ success: boolean; runs: TaskRunInfo[] }>('/api/tasks/stop', { runId }),

  runLog: (runId: string, after = 0) =>
    getJson<TaskRunResponse>(`/api/tasks/runs/${encodeURIComponent(runId)}${query({ after: after || undefined })}`),

  clearHistory: () => postJson<{ success: boolean; cleared: number; runs: TaskRunInfo[] }>('/api/tasks/clear'),

  eventsUrl: (payload: { runId?: string; after?: number } = {}) =>
    `/api/tasks/events${query({ runId: payload.runId, after: payload.after || undefined })}`
}
