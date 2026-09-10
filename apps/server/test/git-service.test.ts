import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { commitStaged, diffOf, discardPaths, MAX_PATHSPECS, revertCommit, stagePaths, statusOf, undoLastCommit, unstagePaths, validatePaths } from '../src/git/service.js'
import * as exec from '../src/git/exec.js'
/** validatePaths is the boundary every git pathspec crosses: it must refuse
 *  anything that could be read as an option, escape the root, or break the record
 *  framing git and we both rely on. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-git-'))
fs.mkdirSync(path.join(root, 'src'), { recursive: true })
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('validatePaths', () => {
  it('accepts root-relative paths and normalizes separators', () => {
    const result = validatePaths(root, ['src/a.ts', 'src\\a.ts'])
    expect(result.ok).toBe(true)
    // Both spellings denote the same file, so the pathspec list is deduplicated.
    if (result.ok) expect(result.data).toEqual(['src/a.ts'])
  })

  it('accepts a path that does not exist yet (a deleted file is still a pathspec)', () => {
    expect(validatePaths(root, ['src/gone.ts']).ok).toBe(true)
  })

  it('refuses an empty list', () => {
    expect(validatePaths(root, [])).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses anything git would read as an option', () => {
    expect(validatePaths(root, ['--all'])).toMatchObject({ ok: false })
    expect(validatePaths(root, ['-f'])).toMatchObject({ ok: false })
  })

  it('refuses NUL and newline, which would break record framing', () => {
    expect(validatePaths(root, ['a\0b'])).toMatchObject({ ok: false })
    expect(validatePaths(root, ['a\nb'])).toMatchObject({ ok: false })
  })

  it('refuses absolute paths and parent escapes', () => {
    expect(validatePaths(root, [path.join(root, 'src', 'a.ts')])).toMatchObject({ ok: false })
    expect(validatePaths(root, ['../outside.ts'])).toMatchObject({ ok: false })
    expect(validatePaths(root, ['src/../../outside.ts'])).toMatchObject({ ok: false })
  })

  it('refuses non-strings and blank entries', () => {
    expect(validatePaths(root, [42])).toMatchObject({ ok: false })
    expect(validatePaths(root, ['   '])).toMatchObject({ ok: false })
  })

  it('caps how many paths one call may touch', () => {
    const many = Array.from({ length: MAX_PATHSPECS + 1 }, (_, index) => `src/file${index}.ts`)
    expect(validatePaths(root, many)).toMatchObject({ ok: false })
  })
})

/** An unfinished revert is what the message priority exists for: git leaves the
 *  conflicted file unstaged, so a "nothing staged" check placed first hides the
 *  actual blocker from the user. */
describe('commitStaged during a conflict', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-git-conflict-'))
  const file = path.join(repo, 'conflict.txt')
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('names the conflict instead of reporting an empty index', async () => {
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'botcf-test')
    git('config', 'commit.gpgsign', 'false')
    fs.writeFileSync(file, 'value=base\n')
    git('add', '.')
    git('commit', '-m', 'base')
    fs.writeFileSync(file, 'value=middle\n')
    git('commit', '-am', 'middle')
    const middle = git('rev-parse', 'HEAD').trim()
    fs.writeFileSync(file, 'value=current\n')
    git('commit', '-am', 'current')

    // Reverting the middle commit conflicts with the current content.
    expect(await revertCommit(repo, middle)).toMatchObject({ ok: false })
    const status = await statusOf(repo)
    expect(status.ok && status.data.conflictedCount).toBeGreaterThan(0)

    const commit = await commitStaged(repo, '尝试在冲突期间提交')
    expect(commit.ok).toBe(false)
    if (!commit.ok) expect(commit.error).toContain('冲突')
  })
})

describe('literal Git file selections and safe discards', () => {
  const repos: string[] = []

  function makeRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-git-selection-'))
    repos.push(repo)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'botcf-test')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.autocrlf', 'false')
    return { repo, git }
  }

  afterAll(() => {
    for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true })
  })

  it('stages, diffs, unstages and discards a bracketed filename without touching its glob matches', async () => {
    const { repo, git } = makeRepo()
    const selected = path.join(repo, '[ab].txt')
    const other = path.join(repo, 'a.txt')
    fs.writeFileSync(selected, 'selected before\n')
    fs.writeFileSync(other, 'other before\n')
    git('add', '.')
    git('commit', '-m', 'base')
    fs.writeFileSync(selected, 'selected after\n')
    fs.writeFileSync(other, 'other after\n')

    expect(await stagePaths(repo, ['[ab].txt'])).toMatchObject({ ok: true })
    expect(git('diff', '--cached', '--name-only').trim()).toBe('[ab].txt')
    const diff = await diffOf(repo, '[ab].txt', 'head')
    expect(diff.ok).toBe(true)
    if (diff.ok) {
      expect(diff.data.diff).toContain('+selected after')
      expect(diff.data.diff).not.toContain('other after')
    }
    git('add', 'a.txt')
    expect(await unstagePaths(repo, ['[ab].txt'])).toMatchObject({ ok: true })
    expect(git('diff', '--cached', '--name-only').trim()).toBe('a.txt')
    expect(await discardPaths(repo, ['[ab].txt'])).toMatchObject({ ok: true })
    expect(fs.readFileSync(selected, 'utf8')).toBe('selected before\n')
    expect(fs.readFileSync(other, 'utf8')).toBe('other after\n')
    expect(git('diff', '--cached', '--name-only').trim()).toBe('a.txt')
  })

  it('never deletes the tracked target of an untracked directory symlink or junction', async (context) => {
    const { repo, git } = makeRepo()
    const original = path.join(repo, 'original')
    fs.mkdirSync(original)
    fs.writeFileSync(path.join(original, 'keep.txt'), 'must survive\n')
    git('add', '.')
    git('commit', '-m', 'base')
    const alias = path.join(repo, 'alias')
    try {
      fs.symlinkSync(original, alias, 'junction')
    } catch {
      context.skip()
      return
    }
    const status = await statusOf(repo)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    // Git for Windows walks junctions; POSIX reports the symlink itself.
    const entry = status.data.entries.find((item) => item.path === 'alias' || item.path === 'alias/keep.txt')
    expect(entry).toBeDefined()
    if (!entry) return
    const result = await discardPaths(repo, [entry.path], true)
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(original, 'keep.txt'), 'utf8')).toBe('must survive\n')
    if (entry.path === 'alias') {
      expect(fs.existsSync(alias)).toBe(false)
    } else {
      expect(result).toMatchObject({ data: { deleted: [], skipped: [{ path: 'alias/keep.txt', reason: 'unchanged' }] } })
    }
  })
})
/** Refresh coalescing (plan §5): status is read once per repository top level and
 *  shared by every workspace root inside that repository, so a file-change burst
 *  that refreshes several panels at once degrades into a single `git status`. */
describe('status refresh dedup across roots of one repository', () => {
  const repos: string[] = []
  const gitSync: Record<string, (...args: string[]) => string> = {}

  function makeRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-git-dedup-'))
    repos.push(repo)
    gitSync.run = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    gitSync.run('init', '-b', 'main')
    gitSync.run('config', 'user.email', 'test@example.com')
    gitSync.run('config', 'user.name', 'botcf-test')
    gitSync.run('config', 'commit.gpgsign', 'false')
    gitSync.run('config', 'core.autocrlf', 'false')
    return repo
  }

  afterAll(() => {
    for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true })
  })

  function statusCallCount(spy: ReturnType<typeof vi.spyOn>): number {
    return spy.mock.calls.filter((call) => call[1]?.[0] === 'status').length
  }

  it('concurrent refreshes from two roots inside one repository run git status once', async () => {
    const repo = makeRepo()
    const pkgA = path.join(repo, 'pkg-a')
    const pkgB = path.join(repo, 'pkg-b')
    fs.mkdirSync(pkgA, { recursive: true })
    fs.mkdirSync(pkgB, { recursive: true })
    fs.writeFileSync(path.join(pkgA, 'a.ts'), 'a1\n')
    fs.writeFileSync(path.join(pkgB, 'b.ts'), 'b1\n')
    const spy = vi.spyOn(exec, 'runGit')
    try {
      const [left, right] = await Promise.all([statusOf(pkgA), statusOf(pkgB)])
      expect(left.ok).toBe(true)
      expect(right.ok).toBe(true)
      expect(statusCallCount(spy)).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('serves each root only its own subtree, re-anchored to that root', async () => {
    const repo = makeRepo()
    const pkg = path.join(repo, 'pkg')
    fs.mkdirSync(path.join(repo, 'other'), { recursive: true })
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'in.ts'), 'x\n')
    fs.writeFileSync(path.join(repo, 'other', 'out.ts'), 'y\n')
    const result = await statusOf(pkg)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.entries.map((entry) => entry.path)).toEqual(['in.ts'])
  })

  it('a mutation invalidates the memoised snapshot so the next refresh is a real read', async () => {
    const repo = makeRepo()
    const file = path.join(repo, 'tracked.txt')
    fs.writeFileSync(file, 'base\n')
    gitSync.run('add', '.')
    gitSync.run('commit', '-m', 'base')
    const spy = vi.spyOn(exec, 'runGit')
    try {
      const before = await statusOf(repo)
      expect(before.ok).toBe(true)
      fs.writeFileSync(file, 'changed\n')
      const staged = await stagePaths(repo, ['tracked.txt'])
      expect(staged.ok).toBe(true)
      const refresh = await statusOf(repo)
      expect(refresh.ok).toBe(true)
      if (refresh.ok) {
        const stagedEntries = refresh.data.entries.filter((entry) => entry.path === 'tracked.txt' && entry.staged)
        expect(stagedEntries).toHaveLength(1)
      }
      expect(statusCallCount(spy)).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('undo then discard leaves no stale snapshot for an immediate refresh', async () => {
    const repo = makeRepo()
    const file = path.join(repo, 'tracked.txt')
    fs.writeFileSync(file, 'base\n')
    gitSync.run('add', '.')
    gitSync.run('commit', '-m', 'base')
    fs.writeFileSync(file, 'second\n')
    gitSync.run('add', '.')
    gitSync.run('commit', '-m', 'second')
    fs.writeFileSync(file, 'third\n')

    expect((await undoLastCommit(repo, 'mixed')).ok).toBe(true)
    const afterUndo = await statusOf(repo)
    expect(afterUndo.ok && afterUndo.data.entries.some((entry) => entry.path === 'tracked.txt')).toBe(true)
    // Both operations read status internally, which used to re-populate the
    // memoised pre-mutation snapshot and serve it to this refresh.
    const discard = await discardPaths(repo, ['tracked.txt'])
    expect(discard.ok).toBe(true)
    const refresh = await statusOf(repo)
    expect(refresh.ok && refresh.data.entries).toEqual([])
  })
})
