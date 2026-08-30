import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { commitStaged, MAX_PATHSPECS, revertCommit, statusOf, validatePaths } from '../src/git/service.js'

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
