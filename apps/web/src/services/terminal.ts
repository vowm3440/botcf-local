import type { WorkspaceRootInfo } from '../api'
import { getJson, postJson, query } from './http'

/** Built-in terminal client.
 *
 *  A session is a shell running in one workspace root. The transcript is a ring
 *  buffer with monotonic `seq` numbers: the panel loads a snapshot, then streams,
 *  passing the last seq it rendered so a reconnect never duplicates or loses a
 *  line. There is no PTY behind it — line-oriented commands only. */

export type TerminalLineKind = 'stdout' | 'stderr' | 'input' | 'system'

export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'sh' | 'zsh'

export interface TerminalLine {
  seq: number
  at: number
  kind: TerminalLineKind
  text: string
}

export interface TerminalSessionInfo {
  id: string
  rootId: string
  rootName: string
  cwd: string
  shell: string
  shellKind: string
  running: boolean
  exitCode: number | null
  startedAt: number
  lastActivityAt: number
  lastSeq: number
}

export interface TerminalListResponse {
  success: boolean
  sessions: TerminalSessionInfo[]
  roots: WorkspaceRootInfo[]
  shellKinds: ShellKind[]
  platformShell: ShellKind
}

export interface TerminalSessionResponse {
  success: boolean
  session: TerminalSessionInfo
  lines: TerminalLine[]
}

export type TerminalEvent =
  | { type: 'terminal_sessions'; sessions: TerminalSessionInfo[] }
  | { type: 'terminal_line'; sessionId: string; line: TerminalLine }
  | { type: 'terminal_exit'; sessionId: string; code: number | null; sessions: TerminalSessionInfo[] }

export const terminalApi = {
  list: () => getJson<TerminalListResponse>('/api/terminal/sessions'),

  open: (payload: { root?: string; shell?: ShellKind } = {}) =>
    postJson<TerminalSessionResponse>('/api/terminal/sessions', payload),

  transcript: (id: string, after = 0) =>
    getJson<TerminalSessionResponse>(`/api/terminal/sessions/${encodeURIComponent(id)}${query({ after: after || undefined })}`),

  send: (id: string, data: string) =>
    postJson<{ success: boolean; session: TerminalSessionInfo }>(`/api/terminal/sessions/${encodeURIComponent(id)}/input`, { data }),

  interrupt: (id: string) =>
    postJson<{ success: boolean; session: TerminalSessionInfo }>(`/api/terminal/sessions/${encodeURIComponent(id)}/interrupt`),

  close: (id: string) =>
    postJson<{ success: boolean; sessions: TerminalSessionInfo[] }>(`/api/terminal/sessions/${encodeURIComponent(id)}/close`),

  eventsUrl: (payload: { id?: string; after?: number } = {}) =>
    `/api/terminal/events${query({ id: payload.id, after: payload.after || undefined })}`
}
