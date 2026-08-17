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
  omp: { available: boolean; running: boolean }
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

export interface ModelHealthCell {
  start: number
  total: number
  failed: number
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
  errorRate: number | null
  avgTtftSeconds: number | null
  throughputTps: number | null
  cells: ModelHealthCell[]
}

export interface SiteHealthMeta {
  generatedAt: number
  bucketMs: number
  errorThreshold: number | null
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

  abort: () => fetch('/api/chat/abort', { method: 'POST' }).then((r) => json<{ success: boolean }>(r)),

  ompStatus: () =>
    fetch('/api/omp/status').then((r) =>
      json<{
        success: boolean
        available: boolean
        running: boolean
        protocolError: string | null
        workdir: string | null
        update: OmpUpdateState
      }>(r)
    ),

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

  setWorkdir: (path: string) =>
    fetch('/api/omp/workdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }).then((r) => json<{ success: boolean; workdir: string; restarted: boolean }>(r)),

  files: (relPath: string) =>
    fetch(`/api/omp/files?path=${encodeURIComponent(relPath)}`).then((r) =>
      json<{ success: boolean; workdir: string | null; path: string; entries: FileEntry[]; truncated: boolean }>(r)
    ),

  fileContent: (relPath: string) =>
    fetch(`/api/omp/file?path=${encodeURIComponent(relPath)}`).then((r) =>
      json<{ success: boolean; path: string; size: number; mtimeMs: number; content: string; truncated: boolean; binary: boolean }>(r)
    ),

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
    }).then((r) => json<{ success: boolean }>(r))
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

export interface StreamEvent {
  type: 'delta' | 'usage' | 'done' | 'error' | 'aborted' | 'context' | 'tool' | 'files_changed'
  text?: string
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
