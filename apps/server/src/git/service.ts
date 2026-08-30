import fs from 'node:fs'
import path from 'node:path'
import { locateInsideRoot } from '../fsContainment.js'
import { readFileBounded } from '../textFile.js'
import { isGitAvailable, runGit } from './exec.js'
import {
  EMPTY_BRANCH,
  LOG_PRETTY_FORMAT,
  parseLog,
  parseStatusPorcelain,
  synthesizeAddedDiff,
  type GitCommit,
  type GitStatusEntry
} from './porcelain.js'

/** Git operations for one workspace root: status, diff, staging, commit and the
 *  two kinds of rollback (throw away working-tree changes, or undo a commit).
 *
 *  Boundaries this module enforces, because it is reachable from HTTP:
 *   - a *root-relative* path is the only path form accepted; it is contained to
 *     the root (string + realpath) before it becomes a pathspec or an unlink;
 *   - nothing that could be read as an option (a leading `-`) is ever passed as
 *     a path, and no value is interpolated into a shell — see git/exec.ts;
 *   - history is only ever rewritten by an explicit request, and never silently
 *     when the branch is already published;
 *   - all output is bounded, so a huge diff cannot become a huge JSON body.
 *
 *  A workspace root may be a *subdirectory* of the repository (a package inside
 *  a monorepo). git reports paths relative to the repository top level, so every
 *  entry is re-anchored to the root via the repository prefix, keeping one path
 *  form (`<rootName>/<relative>`) across the whole UI. */

export type GitOutcome<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

const fail = (status: number, error: string): GitOutcome<never> => ({ ok: false, status, error })

export interface GitRepoInfo {
  /** False when no `git` executable exists on this machine. */
  installed: boolean
  repository: boolean
  /** Absolute path of the repository top level. */
  topLevel: string | null
  /** Root path relative to the top level, '' when the root *is* the top level. */
  prefix: string
  error: string | null
}

const NOT_A_REPO: GitRepoInfo = { installed: true, repository: false, topLevel: null, prefix: '', error: null }

/** Maximum status entries returned; a repository with a huge untracked tree must
 *  not turn the panel into a megabyte of JSON. */
export const MAX_STATUS_ENTRIES = 2_000
export const MAX_DIFF_CHARS = 400_000
export const MAX_LOG_COMMITS = 100
export const MAX_PATHSPECS = 200
export const MAX_COMMIT_MESSAGE_CHARS = 8_192

const toPosix = (value: string): string => value.replace(/\\/g, '/')

export async function repoInfo(rootPath: string): Promise<GitRepoInfo> {
  if (!(await isGitAvailable())) {
    return { installed: false, repository: false, topLevel: null, prefix: '', error: '未找到 git 可执行文件' }
  }
  if (!fs.existsSync(rootPath)) {
    return { ...NOT_A_REPO, error: '目录不存在' }
  }
  const result = await runGit(rootPath, ['rev-parse', '--show-toplevel', '--show-prefix'])
  if (!result.ok) {
    const message = result.stderr.trim()
    // "not a git repository" is the normal answer for a plain directory, not an
    // error the user needs to act on.
    return /not a git repository/i.test(message) ? NOT_A_REPO : { ...NOT_A_REPO, error: message.slice(0, 300) }
  }
  const [topLevel = '', prefix = ''] = result.stdout.split(/\r?\n/)
  return {
    installed: true,
    repository: topLevel.trim() !== '',
    topLevel: topLevel.trim() || null,
    prefix: prefix.trim(),
    error: null
  }
}

export interface GitStatusPayload {
  info: GitRepoInfo
  branch: ReturnType<typeof parseStatusPorcelain>['branch']
  entries: GitStatusEntry[]
  truncated: boolean
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictedCount: number
  /** Head commit, when the repository has one. */
  head: GitCommit | null
}

/** Re-anchor a repository-relative path onto the workspace root. A path outside
 *  the root (possible for the *old* side of a rename) is returned unchanged and
 *  stays display-only. */
function stripPrefix(prefix: string, repoPath: string): string {
  if (!prefix) return repoPath
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath
}

function anchorEntry(prefix: string, entry: GitStatusEntry): GitStatusEntry {
  return {
    ...entry,
    path: stripPrefix(prefix, entry.path),
    ...(entry.from ? { from: stripPrefix(prefix, entry.from) } : {})
  }
}

async function headCommit(rootPath: string): Promise<GitCommit | null> {
  const result = await runGit(rootPath, ['log', '-1', LOG_PRETTY_FORMAT])
  if (!result.ok) return null
  return parseLog(result.stdout)[0] ?? null
}

export async function statusOf(rootPath: string): Promise<GitOutcome<GitStatusPayload>> {
  const info = await repoInfo(rootPath)
  if (!info.installed || !info.repository) {
    return {
      ok: true,
      data: {
        info,
        branch: EMPTY_BRANCH,
        entries: [],
        truncated: false,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        head: null
      }
    }
  }
  // `-- .` keeps a monorepo package's panel to its own subtree; paths are still
  // repository-relative, so they are re-anchored below.
  const args = ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']
  if (info.prefix) args.push('--', '.')
  const result = await runGit(rootPath, args)
  if (!result.ok) return fail(500, result.stderr.trim().slice(0, 300) || 'git status 失败')
  const snapshot = parseStatusPorcelain(result.stdout)
  const anchored = snapshot.entries.map((entry) => anchorEntry(info.prefix, entry))
  const entries = anchored.slice(0, MAX_STATUS_ENTRIES)
  return {
    ok: true,
    data: {
      info,
      branch: snapshot.branch,
      entries,
      truncated: anchored.length > entries.length,
      stagedCount: anchored.filter((entry) => entry.staged).length,
      unstagedCount: anchored.filter((entry) => entry.unstaged && !entry.untracked).length,
      untrackedCount: anchored.filter((entry) => entry.untracked).length,
      conflictedCount: anchored.filter((entry) => entry.conflicted).length,
      head: snapshot.branch.unborn ? null : await headCommit(rootPath)
    }
  }
}

/** Validate root-relative paths before they become pathspecs or unlink targets. */
export function validatePaths(rootPath: string, requested: readonly unknown[]): GitOutcome<string[]> {
  if (!Array.isArray(requested) || requested.length === 0) return fail(400, '缺少文件路径')
  if (requested.length > MAX_PATHSPECS) return fail(400, `一次最多处理 ${MAX_PATHSPECS} 个文件`)
  const paths: string[] = []
  for (const raw of requested) {
    if (typeof raw !== 'string' || raw.trim() === '') return fail(400, '文件路径必须是非空字符串')
    const relative = toPosix(raw.trim())
    // A leading dash would be read as an option, NUL/newline would break the
    // record framing git and we both rely on.
    if (relative.startsWith('-') || /[\0\r\n]/.test(relative)) return fail(400, `非法文件路径: ${relative.slice(0, 80)}`)
    if (path.isAbsolute(relative)) return fail(400, '文件路径必须是相对于目录的路径')
    if (locateInsideRoot(rootPath, relative).status === 'outside') {
      return fail(400, `路径越出目录: ${relative.slice(0, 80)}`)
    }
    paths.push(relative)
  }
  return { ok: true, data: [...new Set(paths)] }
}

async function requireRepo(rootPath: string): Promise<GitOutcome<GitRepoInfo>> {
  const info = await repoInfo(rootPath)
  if (!info.installed) return fail(409, '本机没有安装 git')
  if (!info.repository) return fail(409, '该目录不是 git 仓库')
  return { ok: true, data: info }
}

export interface GitDiffPayload {
  path: string
  /** Which two sides were compared. */
  mode: GitDiffMode
  /** True when the file is not tracked yet, so the diff is synthesized. */
  untracked: boolean
  diff: string
  truncated: boolean
}

/** worktree — unstaged edits; staged — what a commit would include;
 *  head — every uncommitted change to the file, which is what review needs. */
export type GitDiffMode = 'worktree' | 'staged' | 'head'

const capDiff = (diff: string): { diff: string; truncated: boolean } =>
  diff.length > MAX_DIFF_CHARS
    ? { diff: `${diff.slice(0, MAX_DIFF_CHARS)}\n… (差异超过 ${MAX_DIFF_CHARS} 字符,已截断)`, truncated: true }
    : { diff, truncated: false }

/** Diff of a file that git cannot compare against anything: untracked, or tracked
 *  in a repository that has no commit yet. Rendered as an all-added diff. */
function addedFileDiff(rootPath: string, relPath: string): GitOutcome<GitDiffPayload> {
  const located = locateInsideRoot(rootPath, relPath)
  if (located.status !== 'ok') return fail(404, '文件不存在或已被删除')
  try {
    if (!fs.statSync(located.target).isFile()) return fail(400, '不是文件')
    const file = readFileBounded(located.target)
    const diff = file.binary
      ? `二进制新文件,无法显示差异: ${relPath}`
      : synthesizeAddedDiff(relPath, file.content, file.truncated)
    return { ok: true, data: { path: relPath, mode: 'head', untracked: true, ...capDiff(diff) } }
  } catch (err: unknown) {
    // Deleted or replaced between the containment check and the read.
    return fail(404, `无法读取文件: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function diffOf(
  rootPath: string,
  relPath: string,
  mode: GitDiffMode = 'worktree'
): Promise<GitOutcome<GitDiffPayload>> {
  const repo = await requireRepo(rootPath)
  if (!repo.ok) return repo
  const validated = validatePaths(rootPath, [relPath])
  if (!validated.ok) return validated
  const [target] = validated.data

  const tracked = await runGit(rootPath, ['ls-files', '-z', '--', target])
  if (tracked.ok && tracked.stdout.replace(/\0/g, '').trim() === '') {
    return addedFileDiff(rootPath, target)
  }

  const args = ['diff', '--no-color']
  if (mode === 'staged') args.push('--cached')
  if (mode === 'head') {
    // Before the first commit there is no HEAD to compare against; the file is
    // entirely new as far as history is concerned.
    const head = await runGit(rootPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (!head.ok || head.stdout.trim() === '') return addedFileDiff(rootPath, target)
    args.push('HEAD')
  }
  args.push('--', target)
  const result = await runGit(rootPath, args)
  if (!result.ok) return fail(500, result.stderr.trim().slice(0, 300) || 'git diff 失败')
  return { ok: true, data: { path: target, mode, untracked: false, ...capDiff(result.stdout) } }
}

export async function stagePaths(rootPath: string, relPaths: readonly unknown[]): Promise<GitOutcome<{ paths: string[] }>> {
  const repo = await requireRepo(rootPath)
  if (!repo.ok) return repo
  const validated = validatePaths(rootPath, relPaths)
  if (!validated.ok) return validated
  // `--all` records deletions too, so staging a deleted file works like the rest.
  const result = await runGit(rootPath, ['add', '--all', '--', ...validated.data])
  if (!result.ok) return fail(500, result.stderr.trim().slice(0, 300) || 'git add 失败')
  return { ok: true, data: { paths: validated.data } }
}

export async function unstagePaths(rootPath: string, relPaths: readonly unknown[]): Promise<GitOutcome<{ paths: string[] }>> {
  const repo = await requireRepo(rootPath)
  if (!repo.ok) return repo
  const validated = validatePaths(rootPath, relPaths)
  if (!validated.ok) return validated
  const status = await statusOf(rootPath)
  if (!status.ok) return status
  // Before the first commit there is no HEAD to reset against; dropping the
  // index entry is the equivalent, and it keeps the file on disk.
  const args = status.data.branch.unborn
    ? ['rm', '--cached', '-q', '--', ...validated.data]
    : ['reset', '-q', '--', ...validated.data]
  const result = await runGit(rootPath, args)
  if (!result.ok) return fail(500, result.stderr.trim().slice(0, 300) || 'git reset 失败')
  return { ok: true, data: { paths: validated.data } }
}

export interface DiscardOutcome {
  /** Paths restored from the index/HEAD. */
  restored: string[]
  /** New files removed from disk. */
  deleted: string[]
  skipped: Array<{ path: string; reason: 'unchanged' | 'new-file' | 'conflicted' }>
}

/** Throw away working-tree changes. New files are only deleted when the caller
 *  asks for it explicitly (`deleteNew`), because deleting is not recoverable
 *  through git — everything else is restored from the index or HEAD. */
export async function discardPaths(
  rootPath: string,
  relPaths: readonly unknown[],
  deleteNew = false
): Promise<GitOutcome<DiscardOutcome>> {
  const repo = await requireRepo(rootPath)
  if (!repo.ok) return repo
  const validated = validatePaths(rootPath, relPaths)
  if (!validated.ok) return validated
  const status = await statusOf(rootPath)
  if (!status.ok) return status

  const byPath = new Map(status.data.entries.map((entry) => [entry.path, entry]))
  const outcome: DiscardOutcome = { restored: [], deleted: [], skipped: [] }
  const restore: string[] = []
  const unstage: string[] = []
  const remove: string[] = []

  for (const target of validated.data) {
    const entry = byPath.get(target)
    if (!entry) {
      outcome.skipped.push({ path: target, reason: 'unchanged' })
      continue
    }
    if (entry.conflicted) {
      outcome.skipped.push({ path: target, reason: 'conflicted' })
      continue
    }
    const isNew = entry.untracked || entry.index === 'A'
    if (isNew) {
      if (!deleteNew) {
        outcome.skipped.push({ path: target, reason: 'new-file' })
        continue
      }
      if (entry.index === 'A') unstage.push(target)
      remove.push(target)
      continue
    }
    if (entry.staged) unstage.push(target)
    restore.push(target)
    // A staged rename left the old path deleted in the index; restore it too.
    if (entry.from && entry.from !== target) {
      unstage.push(entry.from)
      restore.push(entry.from)
    }
  }

  if (unstage.length > 0) {
    const args = status.data.branch.unborn
      ? ['rm', '--cached', '-q', '--', ...unstage]
      : ['reset', '-q', '--', ...unstage]
    const result = await runGit(rootPath, args)
    if (!result.ok) return fail(500, result.stderr.trim().slice(0, 300) || 'git reset 失败')
  }
  if (restore.length > 0) {
    const result = await runGit(rootPath, ['checkout', '-q', '--', ...restore])
    if (!result.ok) return fail(500, result.stderr.trim().slice(0, 300) || 'git checkout 失败')
    outcome.restored.push(...restore)
  }
  for (const target of remove) {
    // Re-check containment against the real path: this is the one branch that
    // deletes from disk, so it must not trust the earlier string check alone.
    const located = locateInsideRoot(rootPath, target)
    if (located.status !== 'ok') {
      outcome.skipped.push({ path: target, reason: 'unchanged' })
      continue
    }
    try {
      fs.rmSync(located.target, { recursive: true, force: true })
      outcome.deleted.push(target)
    } catch {
      outcome.skipped.push({ path: target, reason: 'unchanged' })
    }
  }
  return { ok: true, data: outcome }
}

export interface CommitPayload {
  commit: GitCommit | null
  staged: number
}

export async function commitStaged(
  rootPath: string,
  message: string,
  options: { paths?: readonly unknown[]; stageAll?: boolean } = {}
): Promise<GitOutcome<CommitPayload>> {
  const repo = await requireRepo(rootPath)
  if (!repo.ok) return repo
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) return fail(400, '提交信息不能为空')
  if (text.length > MAX_COMMIT_MESSAGE_CHARS) return fail(400, `提交信息超过 ${MAX_COMMIT_MESSAGE_CHARS} 字符`)

  if (options.stageAll) {
    const staged = await runGit(rootPath, ['add', '--all', '--', '.'])
    if (!staged.ok) return fail(500, staged.stderr.trim().slice(0, 300) || 'git add 失败')
  } else if (options.paths && options.paths.length > 0) {
    const staged = await stagePaths(rootPath, options.paths)
    if (!staged.ok) return staged
  }

  const status = await statusOf(rootPath)
  if (!status.ok) return status
  // Conflicts are reported before the empty-index check: a conflicted file is
  // never staged, so the generic "nothing staged" message would hide the real
  // blocker (an unfinished merge/revert) from the user.
  if (status.data.conflictedCount > 0) {
    return fail(409, '仓库存在未解决的冲突,先解决冲突或放弃回滚,再提交')
  }
  if (status.data.stagedCount === 0) {
    return fail(409, '没有已暂存的修改,先把要提交的文件加入暂存区')
  }

  // The message travels on stdin: no argv quoting, no shell, any length.
  const result = await runGit(rootPath, ['commit', '--cleanup=whitespace', '-F', '-'], { stdin: `${text}\n` })
  if (!result.ok) {
    const stderr = `${result.stderr}\n${result.stdout}`
    if (/Please tell me who you are|unable to auto-detect email/i.test(stderr)) {
      return fail(409, '提交失败:git 还没有配置身份,请先运行 git config user.name 与 user.email')
    }
    return fail(500, stderr.trim().slice(0, 500) || 'git commit 失败')
  }
  return { ok: true, data: { commit: await headCommit(rootPath), staged: status.data.stagedCount } }
}

export async function logOf(rootPath: string, limit = 30): Promise<GitOutcome<{ commits: GitCommit[] }>> {
  const repo = await requireRepo(rootPath)
  if (!repo.ok) return repo
  const count = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_LOG_COMMITS)
  const result = await runGit(rootPath, ['log', `-n${count}`, LOG_PRETTY_FORMAT])
  if (!result.ok) {
    // A repository without commits is not an error worth surfacing as one.
    if (/does not have any commits yet|bad default revision/i.test(result.stderr)) {
      return { ok: true, data: { commits: [] } }
    }
    return fail(500, result.stderr.trim().slice(0, 300) || 'git log 失败')
  }
  return { ok: true, data: { commits: parseLog(result.stdout) } }
}

export const COMMIT_HASH = /^[0-9a-fA-F]{7,40}$/

export type UndoMode = 'soft' | 'mixed'

/** Undo the last commit by moving the branch pointer back one step. The changes
 *  stay on disk either way (`soft` keeps them staged, `mixed` unstages them) —
 *  no mode here can delete work. Refuses to rewrite a commit that is already on
 *  the upstream branch unless the caller insists. */
export async function undoLastCommit(
  rootPath: string,
  mode: UndoMode = 'mixed',
  force = false
): Promise<GitOutcome<{ mode: UndoMode; head: GitCommit | null }>> {
  const repo = await requireRepo(rootPath)
  if (!repo.ok) return repo
  const status = await statusOf(rootPath)
  if (!status.ok) return status
  if (status.data.branch.unborn || !status.data.head) return fail(409, '还没有提交可以撤销')
  const parents = await runGit(rootPath, ['rev-list', '--count', 'HEAD'])
  if (parents.ok && Number(parents.stdout.trim()) <= 1) {
    return fail(409, '这是仓库的第一个提交,无法回退上一个提交')
  }
  if (!force && status.data.branch.upstream && status.data.branch.ahead === 0) {
    return fail(409, `提交已推送到 ${status.data.branch.upstream},撤销会改写历史。可改用「回滚提交」生成一个反向提交`)
  }
  const result = await runGit(rootPath, ['reset', `--${mode}`, 'HEAD~1'])
  if (!result.ok) return fail(500, result.stderr.trim().slice(0, 300) || 'git reset 失败')
  return { ok: true, data: { mode, head: await headCommit(rootPath) } }
}

/** Roll a commit back by creating its inverse — the safe rollback for published
 *  history, because nothing existing is rewritten. */
export async function revertCommit(rootPath: string, hash: string): Promise<GitOutcome<{ head: GitCommit | null }>> {
  const repo = await requireRepo(rootPath)
  if (!repo.ok) return repo
  if (typeof hash !== 'string' || !COMMIT_HASH.test(hash.trim())) return fail(400, '提交 hash 格式不正确')
  const result = await runGit(rootPath, ['revert', '--no-edit', hash.trim()])
  if (!result.ok) {
    const stderr = `${result.stderr}\n${result.stdout}`.trim()
    if (/conflict/i.test(stderr)) {
      return fail(409, `回滚产生冲突,已停在冲突状态。解决后 git revert --continue,或用「放弃回滚」还原:\n${stderr.slice(0, 300)}`)
    }
    return fail(500, stderr.slice(0, 500) || 'git revert 失败')
  }
  return { ok: true, data: { head: await headCommit(rootPath) } }
}

export async function abortRevert(rootPath: string): Promise<GitOutcome<{ aborted: true }>> {
  const repo = await requireRepo(rootPath)
  if (!repo.ok) return repo
  const result = await runGit(rootPath, ['revert', '--abort'])
  if (!result.ok) return fail(409, result.stderr.trim().slice(0, 300) || '当前没有进行中的回滚')
  return { ok: true, data: { aborted: true } }
}
