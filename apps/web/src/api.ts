/** Typed fetch helpers for the local control backend. */

export interface UserInfo {
  username: string
  displayName: string
  defaultGroup: string
  quota: number
  usedQuota: number
  quotaUsd: number
  usedQuotaUsd: number
  requestCount: number
}

export interface GroupInfo {
  name: string
  apiType: 'responses' | 'chat' | 'messages'
  usable: boolean
  hidden: boolean
  reason?: string
  description?: string
}

export interface ModelInfo {
  id: string
  apiType: string
  thinkingLevels: string[]
  contextLabel: string
  effectiveContext: number
  confidence: string
}

export interface RouteInfo {
  group: string
  modelId: string
  apiType: string
  thinkingLevel: string | null
  capabilityLabel: string
  effectiveContext: number
}

export interface AppStateInfo {
  authenticated: boolean
  mode: 'botcf' | 'third-party'
  thirdParty: { baseUrl: string; models: string[] } | null
  user: UserInfo | null
  route: RouteInfo | null
  /** Server is still re-arming the saved route after a restart; `route: null`
   *  is not final while this is true. */
  restoring?: boolean
  omp: { available: boolean; running: boolean; accessMode: AccessMode }
  generationInFlight: boolean
}

export interface OmpUpdateState {
  currentVersion: string | null
  previousVersion: string | null
  latestUpstream: string | null
  channel: 'fast' | 'stable' | 'experimental'
  repo: string | null
  lastError: string | null
  lastCheckedAt: number | null
}

export type OmpUpdatePhase =
  | 'found'
  | 'waiting-delay'
  | 'waiting-idle'
  | 'downloading'
  | 'verifying'
  | 'switched'
  | 'rolled-back'
  | 'error'

/** Frame pushed over /api/omp/events while the updater works. */
export interface OmpUpdateEvent {
  type: 'omp_update'
  phase: OmpUpdatePhase
  version: string | null
  error?: string
  state: OmpUpdateState
}

export interface SessionSummary {
  path: string
  id: string
  title: string
  preview: string
  createdAt: number
  updatedAt: number
}

export interface ChangedFileInfo {
  path: string
  tools: string[]
  lastToolCallId: string
  hasDiff: boolean
  isError: boolean
  diff?: string
}

export interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtimeMs: number
}

/** Multi-root workspace ----------------------------------------------------- */

/** One open project directory. `name` is the leading segment of every qualified
 *  workspace path (`<name>/<relative>`) inside this root. */
export interface WorkspaceRootInfo {
  id: string
  name: string
  path: string
  /** False once the directory disappeared; it stays listed so it can be removed. */
  exists: boolean
  /** The agent's cwd. Exactly one root is primary while the workspace is open. */
  primary: boolean
}

export interface WorkspaceInfo {
  roots: WorkspaceRootInfo[]
  primaryId: string | null
  /** Primary root path — OMP's working directory. */
  workdir: string | null
  maxRoots: number
}

export interface WorkspaceMutation extends WorkspaceInfo {
  success: boolean
  root: { id: string; name: string; path: string } | null
  /** False when the directory was already open (adding is idempotent). */
  added: boolean
  /** True when OMP restarted because its cwd (the primary root) changed — and came
   *  back carrying the active route again. A restart that lost the route is not one. */
  restarted: boolean
  /** Why the agent runtime could not be brought back; null when nothing went
   *  wrong. The workspace change itself applied either way. */
  runtimeError: string | null
}

/** Root a file/directory response resolved into; null for the workspace itself. */
export type PathRoot = { id: string; name: string } | null

/** How the server decoded a previewed file; `binary` means it could not. */
export type ContentEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be' | 'binary'

/** Live preview ------------------------------------------------------------- */

export type PreviewMode = 'static' | 'command'

export type PreviewPhase = 'stopped' | 'starting' | 'running' | 'error'

export type PreviewReloadKind = 'css' | 'reload'

export interface PreviewState {
  phase: PreviewPhase
  mode: PreviewMode | null
  running: boolean
  url: string | null
  port: number | null
  script: string | null
  command: string | null
  workdir: string | null
  error: string | null
  startedAt: number | null
  lastReloadAt: number | null
  lastReloadKind: PreviewReloadKind | null
  clients: number
}

export interface DetectedProject {
  kind: 'vite' | 'next' | 'node-script' | 'static' | 'empty'
  mode: PreviewMode
  script: string | null
  scripts: string[]
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'
  entry: string | null
  reason: string
}

export interface PreviewLogLine {
  at: number
  line: string
}

export interface PreviewStatus {
  success: boolean
  state: PreviewState
  detected: DetectedProject | null
  workdir: string | null
  /** Root the next start would use (or the one currently hosted). */
  root: PathRoot
  roots: WorkspaceRootInfo[]
  logs: PreviewLogLine[]
}

/** Frames pushed over /api/preview/events. */
export type PreviewEvent =
  | { type: 'preview_state'; state: PreviewState }
  | { type: 'preview_log'; at: number; line: string }
  | { type: 'preview_reload'; kind: PreviewReloadKind; paths: string[]; at: number }

export interface ModelHealthCell {
  start: number
  total: number
  failed: number
  errorRate?: number | null
  state: 'ok' | 'warn' | 'error' | 'idle'
}

export interface ModelHealthInfo {
  cells: ModelHealthCell[]
  total: number
  failed: number
  faultRate: number | null
  bucketMs: number
  windowMs: number
}

export interface SiteModelHealthInfo {
  model: string
  requests: number
  errors: number
  successRate: number | null
  errorRate: number | null
  avgTtftSeconds: number | null
  throughputTps: number | null
  displayErrorThreshold: number
  cells: ModelHealthCell[]
}

export interface SiteHealthMeta {
  generatedAt: number
  bucketMs: number
  bucketCount: number
  errorThreshold: number
  refreshMs: number
  group: string
}

export interface LogQuery {
  page?: number
  pageSize?: number
  tokenName?: string
  modelName?: string
  group?: string
  startTs?: number
  endTs?: number
}

export interface UsageLogItem {
  id: number
  type: number
  created_at: number
  model_name: string
  token_name: string
  group: string
  quota: number
  quotaUsd: number
  prompt_tokens: number
  completion_tokens: number
  use_time: number
  is_stream: boolean
}

export interface LogsResponse {
  success: boolean
  items: UsageLogItem[]
  total: number
  page: number
  pageSize: number
}

function logSearchParams(query: LogQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.page !== undefined) params.set('page', String(query.page))
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize))
  if (query.tokenName) params.set('tokenName', query.tokenName)
  if (query.modelName) params.set('modelName', query.modelName)
  if (query.group) params.set('group', query.group)
  if (query.startTs !== undefined) params.set('startTs', String(query.startTs))
  if (query.endTs !== undefined) params.set('endTs', String(query.endTs))
  return params
}

export function logsExportUrl(query: LogQuery, format: 'csv' | 'json'): string {
  const params = logSearchParams(query)
  params.set('format', format)
  return `/api/logs/export?${params}`
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { success?: boolean; error?: string }
  if (!res.ok || body.success === false) {
    throw new Error(body.error ?? `请求失败 (HTTP ${res.status})`)
  }
  return body
}

export const api = {
  state: (): Promise<AppStateInfo & { success: boolean }> => fetch('/api/state').then((r) => json(r)),

  login: (payload: { mode: 'password' | 'token'; username?: string; password?: string; token?: string }) =>
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => json<{ success: boolean; user: UserInfo }>(r)),

  thirdPartyLogin: (payload: { baseUrl: string; apiKey: string; models: string }) =>
    fetch('/api/auth/third-party', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => json<{ success: boolean; thirdParty: { baseUrl: string; models: string[] } }>(r)),

  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then((r) => json<{ success: boolean }>(r)),

  groups: (refresh = false) =>
    fetch(`/api/groups${refresh ? '?refresh=1' : ''}`).then((r) => json<{ success: boolean; groups: GroupInfo[] }>(r)),

  models: (group: string) =>
    fetch(`/api/models?group=${encodeURIComponent(group)}`).then((r) => json<{ success: boolean; models: ModelInfo[] }>(r)),

  setRoute: (payload: { group: string; model: string; thinkingLevel?: string }) =>
    fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => json<{ success: boolean; route: RouteInfo; compactionThreshold: number }>(r)),

  modelHealth: (group: string, model: string) =>
    fetch(`/api/model-health?group=${encodeURIComponent(group)}&model=${encodeURIComponent(model)}`).then((r) =>
      json<{ success: boolean; health: ModelHealthInfo; site: SiteModelHealthInfo | null; siteMeta: SiteHealthMeta | null }>(r)
    ),

  usage: () =>
    fetch('/api/usage').then((r) =>
      json<{
        success: boolean
        account: { quota: number; usedQuota: number; quotaUsd: number; usedQuotaUsd: number; requestCount: number }
        stat: { quota: number; rpm: number; tpm: number }
        recentRequests: Array<{ model: string; group: string; promptTokens: number; completionTokens: number; costUsd: number; useTimeSeconds: number; at: number }>
        quotaPerUnit: number
        refreshedAt: number
      }>(r)
    ),

  logs: (query: LogQuery) => {
    const params = logSearchParams(query)
    return fetch(`/api/logs?${params}`).then((r) => json<LogsResponse>(r))
  },

  abort: () => fetch('/api/chat/abort', { method: 'POST' }).then((r) => json<{ success: boolean }>(r)),

  ompStatus: () =>
    fetch('/api/omp/status').then((r) =>
      json<{
        success: boolean
        available: boolean
        running: boolean
        protocolError: string | null
        accessMode: AccessMode
        workdir: string | null
        workspace: { roots: WorkspaceRootInfo[]; primaryId: string | null; maxRoots: number }
        update: OmpUpdateState
      }>(r)
    ),

  setAccessMode: (accessMode: AccessMode) =>
    fetch('/api/omp/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessMode })
    }).then((r) => json<{ success: boolean; accessMode: AccessMode }>(r)),

  ompCheckUpdate: () =>
    fetch('/api/omp/check-update', { method: 'POST' }).then((r) =>
      json<{ success: boolean; update: OmpUpdateState }>(r)
    ),

  setOmpRepo: (repo: string) =>
    fetch('/api/omp/repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo })
    }).then((r) => json<{ success: boolean; update: { currentVersion: string | null; latestUpstream: string | null; lastError: string | null } }>(r)),

  setOmpChannel: (channel: 'fast' | 'stable' | 'experimental') =>
    fetch('/api/omp/channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel })
    }).then((r) => json<{ success: boolean }>(r)),

  ompRestart: () =>
    fetch('/api/omp/restart', { method: 'POST' }).then((r) =>
      json<{ success: boolean; running: boolean; protocolError: string | null; error?: string }>(r)
    ),

  ompUiResponse: (payload: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) =>
    fetch('/api/omp/ui-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => json<{ success: boolean }>(r)),

  /** Opens `path` as a workspace root *and* makes it the primary one (OMP's cwd);
   *  other open roots are kept. The endpoint predates multi-root support. */
  setWorkdir: (path: string) =>
    fetch('/api/omp/workdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }).then((r) => json<WorkspaceMutation>(r)),

  workspace: () => fetch('/api/workspace').then((r) => json<WorkspaceInfo & { success: boolean }>(r)),

  addWorkspaceRoot: (payload: { path: string; name?: string; primary?: boolean }) =>
    fetch('/api/workspace/roots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => json<WorkspaceMutation>(r)),

  removeWorkspaceRoot: (id: string) =>
    fetch('/api/workspace/roots/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    }).then((r) => json<WorkspaceMutation>(r)),

  /** Move the agent's working directory to another open root (restarts OMP). */
  setPrimaryRoot: (id: string) =>
    fetch('/api/workspace/primary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    }).then((r) => json<WorkspaceMutation>(r)),

  /** Directory listing for a qualified workspace path; '' lists the roots. */
  files: (workspacePath: string) =>
    fetch(`/api/omp/files?path=${encodeURIComponent(workspacePath)}`).then((r) =>
      json<{
        success: boolean
        workdir: string | null
        roots: WorkspaceRootInfo[]
        maxRoots: number
        path: string
        root: PathRoot
        entries: FileEntry[]
        truncated: boolean
      }>(r)
    ),

  fileContent: (workspacePath: string) =>
    fetch(`/api/omp/file?path=${encodeURIComponent(workspacePath)}`).then((r) =>
      json<{ success: boolean; path: string; root: PathRoot; size: number; mtimeMs: number; content: string; truncated: boolean; binary: boolean; encoding: ContentEncoding }>(r)
    ),

  saveFile: (payload: { path: string; content: string; baseMtimeMs?: number }) =>
    fetch('/api/omp/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => json<{ success: boolean; path: string; root: PathRoot; size: number; mtimeMs: number }>(r)),

  history: () =>
    fetch('/api/chat/history').then((r) =>
      json<{ success: boolean; source: 'omp' | 'local'; messages: Array<{ role: 'user' | 'assistant'; content: string }> }>(r)
    ),

  newSession: () => fetch('/api/chat/new', { method: 'POST' }).then((r) => json<{ success: boolean }>(r)),

  sessions: () =>
    fetch('/api/chat/sessions').then((r) =>
      json<{ success: boolean; currentSessionPath: string | null; sessions: SessionSummary[] }>(r)
    ),

  switchSession: (sessionPath: string) =>
    fetch('/api/chat/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionPath })
    }).then((r) => json<{ success: boolean }>(r)),

  steer: (message: string) =>
    fetch('/api/chat/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    }).then((r) => json<{ success: boolean }>(r)),

  previewStatus: (root?: string): Promise<PreviewStatus> =>
    fetch(`/api/preview/status${root ? `?root=${encodeURIComponent(root)}` : ''}`).then((r) => json<PreviewStatus>(r)),

  previewStart: (payload: { mode?: PreviewMode; script?: string; root?: string }) =>
    fetch('/api/preview/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => json<{ success: boolean; state: PreviewState; root: PathRoot; logs: PreviewLogLine[] }>(r)),

  previewStop: () =>
    fetch('/api/preview/stop', { method: 'POST' }).then((r) => json<{ success: boolean; state: PreviewState }>(r)),

  previewReload: () =>
    fetch('/api/preview/reload', { method: 'POST' }).then((r) => json<{ success: boolean; state: PreviewState }>(r))
}

export interface OmpUiRequest {
  type: 'extension_ui_request'
  id: string
  method: string
  title?: string
  message?: string
  placeholder?: string
  options?: Array<string | { label?: string; value?: string }>
  timeout?: number
}

/** Tool-approval mode. `ask` shows OMP's confirm dialogs; `full` answers them
 *  automatically so a run never pauses. It does not widen what tools may do. */
export type AccessMode = 'ask' | 'full'

export interface StreamEvent {
  type: 'delta' | 'reasoning' | 'notice' | 'usage' | 'done' | 'error' | 'aborted' | 'context' | 'tool' | 'files_changed'
  text?: string
  /** `notice` severity — chrome about the run, not model prose. */
  level?: 'info' | 'warn'
  inputTokens?: number
  outputTokens?: number
  tokens?: number
  contextWindow?: number
  percent?: number
  message?: string
  phase?: 'start' | 'update' | 'end'
  id?: string
  name?: string
  args?: unknown
  intent?: string
  path?: string
  output?: string
  diff?: string
  isError?: boolean
  files?: ChangedFileInfo[]
}

/** POST /api/chat/stream and iterate normalized SSE events via fetch streaming. */
export async function streamChat(
  messages: Array<{ role: string; content: string }>,
  onEvent: (ev: StreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `请求失败 (HTTP ${res.status})`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const line = block.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as StreamEvent)
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}
