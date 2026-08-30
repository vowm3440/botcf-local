import { getJson, postJson, query } from './http'
import type { GitFileState } from './git'

/** Agent-change review client.
 *
 *  The list is the set of files the agent reported changing, each with git's live
 *  view of it and a decision (pending / accepted / reverted). Paths are qualified
 *  workspace paths, which is what every other panel speaks. */

export type ReviewDecision = 'pending' | 'accepted' | 'reverted'

export interface ReviewGitInfo {
  state: GitFileState
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export interface ReviewItem {
  path: string
  tools: string[]
  hasDiff: boolean
  isError: boolean
  turn: number
  firstAt: number
  lastAt: number
  decision: ReviewDecision
  decidedAt: number | null
  rootId: string | null
  rootName: string | null
  relative: string | null
  git: ReviewGitInfo | null
  /** git reports no difference any more: committed, or already reverted. */
  settled: boolean
  diffSource: 'git' | 'agent' | null
  outsideWorkspace: boolean
}

export interface ReviewSummary {
  total: number
  pending: number
  accepted: number
  reverted: number
  failed: number
}

export interface ReviewRootInfo {
  id: string
  name: string
  repository: boolean
  installed: boolean
  count: number
  /** Default commit message from this project's template. */
  commitMessage: string
}

export interface ReviewOverview {
  success: boolean
  items: ReviewItem[]
  summary: ReviewSummary
  roots: ReviewRootInfo[]
  gitAvailable: boolean
}

export interface ReviewActionResponse extends ReviewOverview {
  changed: string[]
  notes: string[]
}

export interface ReviewCommitResponse extends ReviewOverview {
  rootName: string
  commit: { hash: string; shortHash: string; subject: string } | null
  committed: string[]
  notes: string[]
}

export interface ReviewDiffResponse {
  success: boolean
  path: string
  source: 'git' | 'agent'
  diff: string
  truncated: boolean
}

export const reviewApi = {
  overview: () => getJson<ReviewOverview>('/api/review'),

  diff: (path: string) => getJson<ReviewDiffResponse>(`/api/review/diff${query({ path })}`),

  accept: (paths: string[]) => postJson<ReviewActionResponse>('/api/review/accept', { paths }),

  revert: (paths: string[], deleteNew = false) =>
    postJson<ReviewActionResponse>('/api/review/revert', { paths, deleteNew }),

  commit: (payload: { root?: string; message?: string; paths?: string[] } = {}) =>
    postJson<ReviewCommitResponse>('/api/review/commit', payload),

  clear: () => postJson<ReviewOverview>('/api/review/clear')
}
