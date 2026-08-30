import type { WorkspaceRootInfo } from '../api'
import { getJson, postJson, query } from './http'

/** Git status / diff / commit / rollback client.
 *
 *  Paths here are **root-relative** (git's own vocabulary) and always travel with
 *  the root they belong to; the panel converts them to qualified workspace paths
 *  (`<rootName>/<relative>`) when it hands a file to the editor. */

export type GitFileState =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'ignored'
  | 'conflicted'

export interface GitStatusEntry {
  path: string
  from?: string
  index: string
  worktree: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
  state: GitFileState
}

export interface GitBranchInfo {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  unborn: boolean
}

export interface GitRepoInfo {
  installed: boolean
  repository: boolean
  topLevel: string | null
  prefix: string
  error: string | null
}

export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  at: number
  subject: string
  refs: string
}

export interface GitRootRef {
  id: string
  name: string
}

export interface GitStatusResponse {
  success: boolean
  root: GitRootRef
  roots: WorkspaceRootInfo[]
  info: GitRepoInfo
  branch: GitBranchInfo
  entries: GitStatusEntry[]
  truncated: boolean
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictedCount: number
  head: GitCommit | null
}

export type GitDiffMode = 'worktree' | 'staged' | 'head'

export interface GitDiffResponse {
  success: boolean
  root: GitRootRef
  path: string
  mode: GitDiffMode
  untracked: boolean
  diff: string
  truncated: boolean
}

export interface GitLogResponse {
  success: boolean
  root: GitRootRef
  commits: GitCommit[]
}

export interface GitDiscardResponse {
  success: boolean
  root: GitRootRef
  restored: string[]
  deleted: string[]
  skipped: Array<{ path: string; reason: 'unchanged' | 'new-file' | 'conflicted' }>
}

export interface GitCommitResponse {
  success: boolean
  root: GitRootRef
  commit: GitCommit | null
  staged: number
}

export const gitApi = {
  status: (root?: string) => getJson<GitStatusResponse>(`/api/git/status${query({ root })}`),

  diff: (payload: { root?: string; path: string; mode?: GitDiffMode }) =>
    getJson<GitDiffResponse>(`/api/git/diff${query({ root: payload.root, path: payload.path, mode: payload.mode })}`),

  log: (payload: { root?: string; limit?: number } = {}) =>
    getJson<GitLogResponse>(`/api/git/log${query({ root: payload.root, limit: payload.limit })}`),

  stage: (payload: { root?: string; paths: string[] }) => postJson<{ success: boolean; paths: string[] }>('/api/git/stage', payload),

  unstage: (payload: { root?: string; paths: string[] }) =>
    postJson<{ success: boolean; paths: string[] }>('/api/git/unstage', payload),

  /** Throw away uncommitted changes; `deleteNew` also removes new files. */
  discard: (payload: { root?: string; paths: string[]; deleteNew?: boolean }) =>
    postJson<GitDiscardResponse>('/api/git/discard', payload),

  commit: (payload: { root?: string; message: string; paths?: string[]; stageAll?: boolean }) =>
    postJson<GitCommitResponse>('/api/git/commit', payload),

  /** Move the branch back one commit, keeping the changes on disk. */
  undo: (payload: { root?: string; mode?: 'soft' | 'mixed'; force?: boolean }) =>
    postJson<{ success: boolean; mode: string; head: GitCommit | null }>('/api/git/undo', payload),

  /** Inverse commit — the rollback that keeps published history intact. */
  revert: (payload: { root?: string; hash: string }) =>
    postJson<{ success: boolean; head: GitCommit | null }>('/api/git/revert', payload),

  revertAbort: (payload: { root?: string } = {}) => postJson<{ success: boolean }>('/api/git/revert-abort', payload)
}
