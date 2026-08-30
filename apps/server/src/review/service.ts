import {
  commitStaged,
  diffOf,
  discardPaths,
  repoInfo,
  stagePaths,
  statusOf,
  type GitRepoInfo
} from '../git/service.js'
import type { GitFileState, GitStatusEntry } from '../git/porcelain.js'
import { renderCommitMessage } from '../projectConfig/schema.js'
import { loadProjectConfig } from '../projectConfig/store.js'
import { rootByName, splitWorkspacePath, type WorkspaceRoot } from '../workspace/model.js'
import { getWorkspace } from '../workspace/store.js'
import {
  emptyReviewState,
  forgetPaths,
  listRecords,
  pathsWithDecision,
  recordTurn,
  setDecision,
  summarize,
  type ChangedFileLike,
  type ReviewRecord,
  type ReviewState,
  type ReviewSummary
} from './model.js'

/** Agent-change review, wired to git.
 *
 *  The review list comes from the agent's own tool stream; the *truth* about each
 *  file comes from git, which is also what makes the two decisions real:
 *   - 接受 (accept) optionally stages the file, so a later commit includes exactly
 *     what was reviewed;
 *   - 撤销 (revert) throws the change away — restored from the index/HEAD, or
 *     deleted when the agent created the file (and only when asked explicitly).
 *
 *  Directories that are not git repositories are still *reviewable* — the agent's
 *  reported diff is shown — but not revertable, and the UI says so rather than
 *  pretending. Nothing here rewrites history or touches a file the agent did not
 *  report changing. */

let state: ReviewState = emptyReviewState

/** Called at the end of each agent turn with that turn's changed files. */
export function recordAgentTurn(files: readonly ChangedFileLike[]): ReviewState {
  state = recordTurn(state, files)
  return state
}

export function clearReview(): ReviewState {
  state = emptyReviewState
  return state
}

interface RootedPath {
  root: WorkspaceRoot
  relative: string
}

/** Split a qualified workspace path into its root and root-relative remainder.
 *  Returns null for anything that is not a file inside an open root: an absolute
 *  path (the agent can edit those, but git-backed review needs a project), or a
 *  bare root name. */
function splitQualified(qualified: string): RootedPath | null {
  const { head, rest } = splitWorkspacePath(qualified)
  if (!head || !rest) return null
  const root = rootByName(getWorkspace(), head)
  if (!root) return null
  return { root, relative: rest }
}

/** Group review paths by the root that owns them, preserving order. */
function groupByRoot(paths: readonly string[]): Map<string, { root: WorkspaceRoot; entries: Array<{ path: string; relative: string }> }> {
  const groups = new Map<string, { root: WorkspaceRoot; entries: Array<{ path: string; relative: string }> }>()
  for (const path of paths) {
    const split = splitQualified(path)
    if (!split) continue
    const group = groups.get(split.root.id)
    if (group) group.entries.push({ path, relative: split.relative })
    else groups.set(split.root.id, { root: split.root, entries: [{ path, relative: split.relative }] })
  }
  return groups
}

export interface ReviewGitInfo {
  state: GitFileState
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export interface ReviewItem extends ReviewRecord {
  rootId: string | null
  rootName: string | null
  relative: string | null
  /** git's view of the file, null when the root is not a repository. */
  git: ReviewGitInfo | null
  /** True when git reports no difference any more: committed, or already reverted. */
  settled: boolean
  /** Where the diff shown in the panel comes from. */
  diffSource: 'git' | 'agent' | null
  /** The agent edited a file outside every workspace root. */
  outsideWorkspace: boolean
}

export interface ReviewRootInfo {
  id: string
  name: string
  repository: boolean
  installed: boolean
  /** Files under review in this root. */
  count: number
  /** Default commit message from this project's template. */
  commitMessage: string
}

export interface ReviewOverview {
  items: ReviewItem[]
  summary: ReviewSummary
  roots: ReviewRootInfo[]
  /** True when at least one root can actually revert/commit. */
  gitAvailable: boolean
}

function gitInfoOf(entry: GitStatusEntry | undefined): ReviewGitInfo | null {
  if (!entry) return null
  return { state: entry.state, staged: entry.staged, unstaged: entry.unstaged, untracked: entry.untracked }
}

/** Decorate the review records with live git state, one status call per root. */
export async function reviewOverview(): Promise<ReviewOverview> {
  const records = listRecords(state)
  const groups = groupByRoot(records.map((record) => record.path))
  const statusByRoot = new Map<string, { info: GitRepoInfo; byPath: Map<string, GitStatusEntry> }>()

  for (const [rootId, group] of groups) {
    const status = await statusOf(group.root.path)
    if (!status.ok) {
      statusByRoot.set(rootId, { info: await repoInfo(group.root.path), byPath: new Map() })
      continue
    }
    statusByRoot.set(rootId, {
      info: status.data.info,
      byPath: new Map(status.data.entries.map((entry) => [entry.path, entry]))
    })
  }

  const items: ReviewItem[] = records.map((record) => {
    const split = splitQualified(record.path)
    if (!split) {
      return {
        ...record,
        rootId: null,
        rootName: null,
        relative: null,
        git: null,
        settled: false,
        diffSource: record.diff ? 'agent' : null,
        outsideWorkspace: true
      }
    }
    const rootStatus = statusByRoot.get(split.root.id)
    const entry = rootStatus?.byPath.get(split.relative)
    const isRepo = rootStatus?.info.repository === true
    return {
      ...record,
      rootId: split.root.id,
      rootName: split.root.name,
      relative: split.relative,
      git: gitInfoOf(entry),
      settled: isRepo ? entry === undefined : false,
      diffSource: isRepo ? 'git' : record.diff ? 'agent' : null,
      outsideWorkspace: false
    }
  })

  const roots: ReviewRootInfo[] = [...groups.entries()].map(([rootId, group]) => {
    const status = statusByRoot.get(rootId)
    const { config } = loadProjectConfig(group.root.path)
    return {
      id: group.root.id,
      name: group.root.name,
      repository: status?.info.repository === true,
      installed: status?.info.installed !== false,
      count: group.entries.length,
      commitMessage: renderCommitMessage(
        config.review.commitTemplate,
        group.entries.map((entry) => entry.relative)
      )
    }
  })

  return {
    items,
    summary: summarize(state),
    roots,
    gitAvailable: roots.some((root) => root.repository)
  }
}

export interface ReviewActionResult {
  ok: true
  /** Paths whose decision changed. */
  changed: string[]
  /** Human-readable notes: staged counts, skipped files, non-repo roots. */
  notes: string[]
}

export type ReviewActionOutcome = ReviewActionResult | { ok: false; status: number; error: string }

function knownPaths(requested: readonly unknown[]): string[] {
  const known: string[] = []
  for (const value of requested) {
    if (typeof value !== 'string') continue
    if (state.records.has(value)) known.push(value)
  }
  return known
}

/** Mark files as reviewed-and-kept, staging them when the project asks for it. */
export async function acceptPaths(requested: readonly unknown[]): Promise<ReviewActionOutcome> {
  const paths = knownPaths(requested)
  if (paths.length === 0) return { ok: false, status: 400, error: '没有可接受的文件' }
  const notes: string[] = []
  for (const [, group] of groupByRoot(paths)) {
    const { config } = loadProjectConfig(group.root.path)
    if (!config.review.stageOnAccept) continue
    const info = await repoInfo(group.root.path)
    if (!info.repository) continue
    const staged = await stagePaths(group.root.path, group.entries.map((entry) => entry.relative))
    if (staged.ok) notes.push(`${group.root.name}: 已暂存 ${staged.data.paths.length} 个文件`)
    else notes.push(`${group.root.name}: 暂存失败 — ${staged.error}`)
  }
  state = setDecision(state, paths, 'accepted')
  return { ok: true, changed: paths, notes }
}

/** Throw the agent's change away. New files are only deleted with `deleteNew`. */
export async function revertPaths(requested: readonly unknown[], deleteNew = false): Promise<ReviewActionOutcome> {
  const paths = knownPaths(requested)
  if (paths.length === 0) return { ok: false, status: 400, error: '没有可撤销的文件' }
  const notes: string[] = []
  const reverted: string[] = []
  for (const [, group] of groupByRoot(paths)) {
    const info = await repoInfo(group.root.path)
    if (!info.installed) return { ok: false, status: 409, error: '本机没有安装 git,无法自动撤销修改' }
    if (!info.repository) {
      notes.push(`${group.root.name}: 不是 git 仓库,无法自动撤销(可在编辑器里手动改回)`)
      continue
    }
    const byRelative = new Map(group.entries.map((entry) => [entry.relative, entry.path]))
    const result = await discardPaths(group.root.path, [...byRelative.keys()], deleteNew)
    if (!result.ok) {
      notes.push(`${group.root.name}: 撤销失败 — ${result.error}`)
      continue
    }
    for (const relative of [...result.data.restored, ...result.data.deleted]) {
      const qualified = byRelative.get(relative)
      if (qualified) reverted.push(qualified)
    }
    if (result.data.restored.length > 0) notes.push(`${group.root.name}: 已还原 ${result.data.restored.length} 个文件`)
    if (result.data.deleted.length > 0) notes.push(`${group.root.name}: 已删除 ${result.data.deleted.length} 个新文件`)
    for (const skipped of result.data.skipped) {
      const reason =
        skipped.reason === 'new-file'
          ? '是新建文件,需要勾选「删除新建文件」才会移除'
          : skipped.reason === 'conflicted'
            ? '处于冲突状态,请先解决冲突'
            : '相对 git 没有改动,无需撤销'
      notes.push(`${group.root.name}/${skipped.path}: ${reason}`)
    }
  }
  if (reverted.length > 0) state = setDecision(state, reverted, 'reverted')
  return { ok: true, changed: reverted, notes }
}

export interface CommitReviewInput {
  /** Root id or name; required when the review spans several roots. */
  root?: string
  message?: string
  /** Defaults to every accepted file in the chosen root. */
  paths?: readonly unknown[]
}

export interface CommitReviewResult {
  ok: true
  rootName: string
  commit: { hash: string; shortHash: string; subject: string } | null
  committed: string[]
  notes: string[]
}

export async function commitReviewed(input: CommitReviewInput): Promise<CommitReviewResult | { ok: false; status: number; error: string }> {
  const requested = input.paths && input.paths.length > 0 ? knownPaths(input.paths) : pathsWithDecision(state, 'accepted')
  if (requested.length === 0) {
    return { ok: false, status: 400, error: '没有已接受的文件可提交,请先接受要保留的修改' }
  }
  const groups = groupByRoot(requested)
  if (groups.size === 0) return { ok: false, status: 400, error: '这些文件不属于任何工作区目录,无法提交' }
  const wanted = (input.root ?? '').trim()
  const group = wanted
    ? [...groups.values()].find((entry) => entry.root.id === wanted || entry.root.name === wanted)
    : groups.size === 1
      ? [...groups.values()][0]
      : null
  if (!group) {
    return {
      ok: false,
      status: 400,
      error: wanted
        ? `所选目录中没有待提交的文件: ${wanted.slice(0, 60)}`
        : `待提交的文件分布在 ${groups.size} 个目录中,请分别选择目录提交`
    }
  }

  const { config } = loadProjectConfig(group.root.path)
  const relatives = group.entries.map((entry) => entry.relative)
  const message =
    typeof input.message === 'string' && input.message.trim() !== ''
      ? input.message.trim()
      : renderCommitMessage(config.review.commitTemplate, relatives)

  const result = await commitStaged(group.root.path, message, { paths: relatives })
  if (!result.ok) return { ok: false, status: result.status, error: result.error }
  const committed = group.entries.map((entry) => entry.path)
  // Committed files are history now; they leave the review list.
  state = forgetPaths(state, committed)
  return {
    ok: true,
    rootName: group.root.name,
    commit: result.data.commit
      ? {
          hash: result.data.commit.hash,
          shortHash: result.data.commit.shortHash,
          subject: result.data.commit.subject
        }
      : null,
    committed,
    notes: [`${group.root.name}: 已提交 ${committed.length} 个文件`]
  }
}

export interface ReviewDiffResult {
  path: string
  source: 'git' | 'agent'
  diff: string
  truncated: boolean
}

/** Diff for one reviewed file: git's live view when possible, else the diff the
 *  agent itself reported for the change. */
export async function reviewDiff(qualified: string): Promise<ReviewDiffResult | { ok: false; status: number; error: string }> {
  const record = state.records.get(qualified)
  if (!record) return { ok: false, status: 404, error: '这个文件不在本次审查列表中' }
  const split = splitQualified(qualified)
  if (split) {
    const info = await repoInfo(split.root.path)
    if (info.repository) {
      const diff = await diffOf(split.root.path, split.relative, 'head')
      if (diff.ok) {
        return { path: qualified, source: 'git', diff: diff.data.diff, truncated: diff.data.truncated }
      }
      if (!record.diff) return { ok: false, status: diff.status, error: diff.error }
    }
  }
  if (!record.diff) return { ok: false, status: 404, error: '没有可显示的差异' }
  return { path: qualified, source: 'agent', diff: record.diff, truncated: false }
}
