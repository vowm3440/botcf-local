import { describe, expect, it } from 'vitest'
import {
  parseBranchHeader,
  parseLog,
  parseNumstat,
  parseStatusPorcelain,
  synthesizeAddedDiff,
  LOG_FIELD_SEPARATOR,
  LOG_RECORD_SEPARATOR
} from '../src/git/porcelain.js'

/** `git status --porcelain=v1 -z -b` output: every record NUL-terminated, a
 *  rename spanning two records (new path, then old). */
function statusOutput(...records: string[]): string {
  return records.map((record) => `${record}\0`).join('')
}

describe('parseBranchHeader', () => {
  it('reads branch, upstream and divergence', () => {
    expect(parseBranchHeader('## master...origin/master [ahead 2, behind 3]')).toEqual({
      branch: 'master',
      upstream: 'origin/master',
      ahead: 2,
      behind: 3,
      detached: false,
      unborn: false
    })
  })

  it('handles a branch without upstream', () => {
    expect(parseBranchHeader('## feature/panel')).toMatchObject({ branch: 'feature/panel', upstream: null, ahead: 0 })
  })

  it('recognizes a detached HEAD', () => {
    expect(parseBranchHeader('## HEAD (no branch)')).toMatchObject({ detached: true, branch: null })
  })

  it('recognizes a repository without commits, old and new wording', () => {
    expect(parseBranchHeader('## No commits yet on main')).toMatchObject({ unborn: true, branch: 'main' })
    expect(parseBranchHeader('## Initial commit on main')).toMatchObject({ unborn: true, branch: 'main' })
  })

  it('reads ahead-only tracking', () => {
    expect(parseBranchHeader('## dev...origin/dev [ahead 1]')).toMatchObject({ ahead: 1, behind: 0 })
  })
})

describe('parseStatusPorcelain', () => {
  it('classifies the common states', () => {
    const { entries } = parseStatusPorcelain(
      statusOutput('## main', 'M  staged.ts', ' M dirty.ts', 'MM both.ts', '?? new.ts', ' D gone.ts', 'A  added.ts')
    )
    expect(entries.map((entry) => [entry.path, entry.state, entry.staged, entry.unstaged])).toEqual([
      ['staged.ts', 'modified', true, false],
      ['dirty.ts', 'modified', false, true],
      ['both.ts', 'modified', true, true],
      ['new.ts', 'untracked', false, true],
      ['gone.ts', 'deleted', false, true],
      ['added.ts', 'added', true, false]
    ])
  })

  it('keeps the branch header out of the entry list', () => {
    const snapshot = parseStatusPorcelain(statusOutput('## main...origin/main [behind 1]', 'M  a.ts'))
    expect(snapshot.branch).toMatchObject({ branch: 'main', behind: 1 })
    expect(snapshot.entries).toHaveLength(1)
  })

  it('reads a rename from its two records and keeps the old path', () => {
    const { entries } = parseStatusPorcelain(statusOutput('## main', 'R  new/name.ts', 'old/name.ts', 'M  other.ts'))
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ path: 'new/name.ts', from: 'old/name.ts', state: 'renamed', staged: true })
    expect(entries[1]).toMatchObject({ path: 'other.ts' })
  })

  it('marks unresolved merges as conflicted and never as staged', () => {
    const { entries } = parseStatusPorcelain(statusOutput('UU both.ts', 'AA added.ts', 'DD gone.ts', 'AU ours.ts'))
    expect(entries.every((entry) => entry.conflicted)).toBe(true)
    expect(entries.every((entry) => entry.staged === false)).toBe(true)
    expect(entries.every((entry) => entry.state === 'conflicted')).toBe(true)
  })

  it('tolerates empty output and an empty repository', () => {
    expect(parseStatusPorcelain('')).toEqual({ branch: expect.objectContaining({ branch: null }), entries: [] })
    expect(parseStatusPorcelain(statusOutput('## No commits yet on main')).entries).toEqual([])
  })

  it('keeps paths with spaces intact (NUL framing, not whitespace)', () => {
    const { entries } = parseStatusPorcelain(statusOutput('M  src/a file.ts'))
    expect(entries[0].path).toBe('src/a file.ts')
  })
})

describe('parseLog', () => {
  const record = (...fields: string[]): string => fields.join(LOG_FIELD_SEPARATOR) + LOG_RECORD_SEPARATOR

  it('parses records into commits', () => {
    const stdout =
      record('a'.repeat(40), 'aaaaaaa', 'Dev', '2026-08-20T10:00:00+08:00', 'HEAD -> master', 'feat: 面板') +
      '\n' +
      record('b'.repeat(40), 'bbbbbbb', 'Other', '2026-08-19T09:00:00+08:00', '', 'fix: 边界')
    const commits = parseLog(stdout)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({ shortHash: 'aaaaaaa', author: 'Dev', subject: 'feat: 面板', refs: 'HEAD -> master' })
    expect(commits[0].at).toBe(Date.parse('2026-08-20T10:00:00+08:00'))
    expect(commits[1].subject).toBe('fix: 边界')
  })

  it('keeps a subject that contains the field separator characters harmlessly', () => {
    const commits = parseLog(record('c'.repeat(40), 'ccccccc', 'Dev', 'not-a-date', '', 'chore: 修改'))
    expect(commits[0].subject).toBe('chore: 修改')
    expect(commits[0].at).toBe(0)
  })

  it('returns nothing for empty output', () => {
    expect(parseLog('')).toEqual([])
  })
})

describe('parseNumstat', () => {
  it('parses counts, binary files and renames', () => {
    const stdout = ['12\t3\tsrc/a.ts\0', '-\t-\tassets/logo.png\0', '4\t5\t\0old/a.ts\0new/a.ts\0'].join('')
    expect(parseNumstat(stdout)).toEqual([
      { path: 'src/a.ts', added: 12, removed: 3 },
      { path: 'assets/logo.png', added: null, removed: null },
      { path: 'new/a.ts', from: 'old/a.ts', added: 4, removed: 5 }
    ])
  })
})

describe('synthesizeAddedDiff', () => {
  it('renders an untracked file as an all-added diff', () => {
    expect(synthesizeAddedDiff('src/new.ts', 'a\nb\n')).toBe(
      ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+a', '+b'].join('\n')
    )
  })

  it('handles an empty file and marks truncation', () => {
    expect(synthesizeAddedDiff('empty.txt', '')).toContain('@@ -0,0 +1,0 @@')
    expect(synthesizeAddedDiff('big.txt', 'a\n', true)).toContain('差异已截断')
  })
})
