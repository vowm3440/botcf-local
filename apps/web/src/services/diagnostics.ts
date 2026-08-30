import { getJson, postJson, query } from './http'

/** Errors & diagnostics center client.
 *
 *  One list for everything that failed: task output parsed into file/line
 *  findings, preview and dev-server failures, agent tool errors, and runtime
 *  errors relayed from the previewed page. */

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export type DiagnosticOrigin = 'task' | 'preview' | 'agent' | 'runtime' | 'server'

export interface Diagnostic {
  id: string
  origin: DiagnosticOrigin
  source: string
  tool: string | null
  severity: DiagnosticSeverity
  /** Qualified workspace path, when the finding could be attributed to a file. */
  path: string | null
  line: number | null
  column: number | null
  code: string | null
  message: string
  at: number
  lastAt: number
  /** Times this identical finding was reported. */
  count: number
  groupId: string | null
}

export interface DiagnosticSummary {
  total: number
  errors: number
  warnings: number
  infos: number
  byOrigin: Record<DiagnosticOrigin, number>
}

export interface DiagnosticsResponse {
  success: boolean
  items: Diagnostic[]
  summary: DiagnosticSummary
  origins: DiagnosticOrigin[]
}

export const ORIGIN_LABELS: Record<DiagnosticOrigin, string> = {
  task: '任务',
  preview: '预览',
  agent: 'AI 运行时',
  runtime: '页面运行时',
  server: '本地服务'
}

export const SEVERITY_LABELS: Record<DiagnosticSeverity, string> = {
  error: '错误',
  warning: '警告',
  info: '提示'
}

export const diagnosticsApi = {
  list: (filter: { origin?: DiagnosticOrigin; severity?: DiagnosticSeverity } = {}) =>
    getJson<DiagnosticsResponse>(`/api/diagnostics${query({ origin: filter.origin, severity: filter.severity })}`),

  clear: (filter: { origin?: DiagnosticOrigin; groupId?: string } = {}) =>
    postJson<DiagnosticsResponse & { cleared: number }>('/api/diagnostics/clear', filter),

  /** Report an error thrown inside the previewed page. */
  reportRuntime: (payload: { message: string; path?: string; line?: number }) =>
    postJson<{ success: boolean }>('/api/diagnostics/runtime', payload),

  eventsUrl: () => '/api/diagnostics/events'
}
