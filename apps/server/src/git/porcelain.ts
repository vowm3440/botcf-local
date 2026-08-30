/** Parsers for git's machine-readable output.
 *
 *  Everything here is a pure string function so the rules stay unit-testable:
 *  status codes, rename records, branch/tracking headers and log records all
 *  have edge cases (unborn HEAD, detached HEAD, NUL-separated rename pairs) that
 *  are far easier to pin down in tests than against a live repository.
 *
 *  Input comes from `git status --porcelain=v1 -z -b`, `git log --pretty` with
 *  unit separators, and `git diff --numstat -z`. */

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
  /** Root-relative POSIX path. */
  path: string
  /** Previous path, for a rename or copy. */
  from?: string
  /** Index (staged) status letter; ' ' when the index matches HEAD. */
  index: string
  /** Worktree status letter; ' ' when the worktree matches the index. */
  worktree: string
  staged: boolean
  /** Worktree differs from the index — the part a commit would *not* include. */
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
  /** Coarse state for display, taken from the side that actually changed. */
  state: GitFileState
}

export interface GitBranchInfo {
  /** Branch name, or null while HEAD is detached. */
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  /** True in a fresh repository: HEAD points at a branch with no commits. */
  unborn: boolean
}

export interface GitStatusSnapshot {
  branch: GitBranchInfo
  entries: GitStatusEntry[]
}

export const EMPTY_BRANCH: GitBranchInfo = {
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false,
  unborn: false
}

const STATE_BY_LETTER: Record<string, GitFileState> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'conflicted'
}

/** Both sides carrying a letter, or either side 'U', means an unresolved merge. */
export function isConflictCode(index: string, worktree: string): boolean {
  if (index === 'U' || worktree === 'U') return true
  return (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')
}

function stateFor(index: string, worktree: string): GitFileState {
  if (index === '?' || worktree === '?') return 'untracked'
  if (index === '!' || worktree === '!') return 'ignored'
  if (isConflictCode(index, worktree)) return 'conflicted'
  // The staged side names the change best (a rename shows as R in the index);
  // fall back to the worktree letter for files that are only edited on disk.
  return STATE_BY_LETTER[index.trim()] ?? STATE_BY_LETTER[worktree.trim()] ?? 'modified'
}

const BRANCH_HEADER = '## '

/** `## master...origin/master [ahead 1, behind 2]` and its many variants. */
export function parseBranchHeader(line: string): GitBranchInfo {
  const body = line.startsWith(BRANCH_HEADER) ? line.slice(BRANCH_HEADER.length) : line
  if (body.startsWith('HEAD (no branch)')) {
    return { ...EMPTY_BRANCH, detached: true }
  }
  // Fresh repository: git 2.x says "No commits yet on <branch>", older versions
  // said "Initial commit on <branch>".
  const unborn = /^(?:No commits yet on|Initial commit on)\s+(.+)$/.exec(body)
  if (unborn) {
    return { ...EMPTY_BRANCH, branch: unborn[1].trim(), unborn: true }
  }
  const tracking = /\s\[(.+)\]$/.exec(body)
  const names = (tracking ? body.slice(0, body.length - tracking[0].length) : body).trim()
  const [branch, upstream] = names.split('...')
  const ahead = tracking ? /ahead (\d+)/.exec(tracking[1]) : null
  const behind = tracking ? /behind (\d+)/.exec(tracking[1]) : null
  return {
    branch: branch?.trim() || null,
    upstream: upstream?.trim() || null,
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    detached: false,
    unborn: false
  }
}

function entryFromRecord(record: string, from?: string): GitStatusEntry | null {
  // `XY <path>`: two status letters, one space, then the path.
  if (record.length < 4) return null
  const index = record[0]
  const worktree = record[1]
  const path = record.slice(3)
  if (!path) return null
  const untracked = index === '?' || worktree === '?'
  const conflicted = isConflictCode(index, worktree)
  return {
    path,
    ...(from ? { from } : {}),
    index,
    worktree,
    // An untracked or conflicted file has nothing staged, whatever the letters
    // look like: '??' is not an index change and 'UU' is an unresolved merge.
    staged: !untracked && !conflicted && index !== ' ',
    unstaged: untracked || conflicted || worktree !== ' ',
    untracked,
    conflicted,
    state: stateFor(index, worktree)
  }
}

/** Parse `git status --porcelain=v1 -z -b`. Records are NUL-terminated, and a
 *  rename/copy is *two* records: the new path, then the old one. */
export function parseStatusPorcelain(stdout: string): GitStatusSnapshot {
  const records = stdout.split('\0')
  let branch = EMPTY_BRANCH
  const entries: GitStatusEntry[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    if (record.startsWith(BRANCH_HEADER)) {
      branch = parseBranchHeader(record)
      continue
    }
    const renaming = record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C'
    const from = renaming ? records[i + 1] : undefined
    if (renaming && from !== undefined) i++
    const entry = entryFromRecord(record, from || undefined)
    if (entry) entries.push(entry)
  }
  return { branch, entries }
}

export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  /** Author date, epoch milliseconds. */
  at: number
  subject: string
  /** Ref names decorating this commit (`HEAD -> master`, tags …). */
  refs: string
}

/** Field/record separators for `git log --pretty`: ASCII US and RS, which
 *  cannot appear in a commit subject. */
export const LOG_FIELD_SEPARATOR = '\x1f'
export const LOG_RECORD_SEPARATOR = '\x1e'
export const LOG_PRETTY_FORMAT = `--pretty=format:%H${LOG_FIELD_SEPARATOR}%h${LOG_FIELD_SEPARATOR}%an${LOG_FIELD_SEPARATOR}%aI${LOG_FIELD_SEPARATOR}%D${LOG_FIELD_SEPARATOR}%s${LOG_RECORD_SEPARATOR}`

export function parseLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of stdout.split(LOG_RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^[\r\n]+/, '')
    if (!trimmed.trim()) continue
    const [hash, shortHash, author, date, refs, ...rest] = trimmed.split(LOG_FIELD_SEPARATOR)
    if (!hash) continue
    const parsed = Date.parse(date ?? '')
    commits.push({
      hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      author: author ?? '',
      at: Number.isFinite(parsed) ? parsed : 0,
      subject: (rest.join(LOG_FIELD_SEPARATOR) ?? '').trim(),
      refs: (refs ?? '').trim()
    })
  }
  return commits
}

export interface GitNumstatEntry {
  path: string
  from?: string
  /** null for a binary file, where git prints `-`. */
  added: number | null
  removed: number | null
}

/** Parse `git diff --numstat -z`. A rename adds two extra NUL-separated fields
 *  (old path, new path) after the counts instead of the usual single path. */
export function parseNumstat(stdout: string): GitNumstatEntry[] {
  const fields = stdout.split('\0')
  const entries: GitNumstatEntry[] = []
  const count = (value: string): number | null => (value === '-' ? null : Number.parseInt(value, 10) || 0)
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field.trim()) continue
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field)
    if (!match) continue
    const [, added, removed, inlinePath] = match
    if (inlinePath) {
      entries.push({ path: inlinePath, added: count(added), removed: count(removed) })
      continue
    }
    // Rename: the two paths follow as separate NUL-terminated fields.
    const from = fields[i + 1]
    const to = fields[i + 2]
    if (from === undefined || to === undefined) continue
    i += 2
    entries.push({ path: to, from, added: count(added), removed: count(removed) })
  }
  return entries
}

/** Unified diff for a file git cannot diff yet (untracked, so not in the index).
 *  Rendering it like a real diff keeps the review UI to one code path. */
export function synthesizeAddedDiff(displayPath: string, content: string, truncated = false): string {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = body === '' ? [] : body.split('\n')
  const header = [`--- /dev/null`, `+++ b/${displayPath}`, `@@ -0,0 +1,${lines.length} @@`]
  const rendered = lines.map((line) => `+${line}`)
  if (truncated) rendered.push('+… (文件超过预览上限,差异已截断)')
  return [...header, ...rendered].join('\n')
}
