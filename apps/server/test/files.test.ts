import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listDirectory, realpathInsideRoot, resolveInsideRoot, sortEntries } from '../src/routes/files.js'

const ROOT = path.resolve('rootdir')

describe('resolveInsideRoot', () => {
  it('resolves the empty request to the root itself', () => {
    expect(resolveInsideRoot(ROOT, '')).toBe(ROOT)
  })

  it('resolves nested relative paths', () => {
    expect(resolveInsideRoot(ROOT, 'sub/dir')).toBe(path.join(ROOT, 'sub', 'dir'))
  })

  it('rejects parent-directory escapes', () => {
    expect(resolveInsideRoot(ROOT, '../evil')).toBeNull()
    expect(resolveInsideRoot(ROOT, 'sub/../../evil')).toBeNull()
  })

  it('rejects absolute paths outside the root but accepts ones inside', () => {
    expect(resolveInsideRoot(ROOT, path.resolve('elsewhere'))).toBeNull()
    expect(resolveInsideRoot(ROOT, path.join(ROOT, 'sub'))).toBe(path.join(ROOT, 'sub'))
  })
})

describe('sortEntries', () => {
  it('sorts directories first, then names', () => {
    const sorted = sortEntries([
      { name: 'z.txt', type: 'file', size: 1, mtimeMs: 0 },
      { name: 'beta', type: 'dir', size: 0, mtimeMs: 0 },
      { name: 'a.txt', type: 'file', size: 1, mtimeMs: 0 },
      { name: 'alpha', type: 'dir', size: 0, mtimeMs: 0 }
    ])
    expect(sorted.map((entry) => entry.name)).toEqual(['alpha', 'beta', 'a.txt', 'z.txt'])
  })
})

describe('filesystem-backed listing and containment', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-files-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-outside-'))
  fs.mkdirSync(path.join(tmpRoot, 'sub'))
  fs.writeFileSync(path.join(tmpRoot, 'b.txt'), 'bb')
  fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'a')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')

  let escapeLink = false
  try {
    fs.symlinkSync(outside, path.join(tmpRoot, 'esc'), 'junction')
    escapeLink = true
  } catch {
    // Symlink creation can be unavailable; the escape test is skipped then.
  }

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('lists entries dirs-first with sizes', () => {
    const { entries, truncated } = listDirectory(tmpRoot)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('sub')
    expect(names).toContain('a.txt')
    expect(names).toContain('b.txt')
    expect(names.indexOf('sub')).toBeLessThan(names.indexOf('a.txt'))
    expect(entries.find((entry) => entry.name === 'sub')?.type).toBe('dir')
    expect(entries.find((entry) => entry.name === 'b.txt')?.size).toBe(2)
    expect(truncated).toBe(false)
  })

  it('caps the number of entries and reports truncation', () => {
    const { entries, truncated } = listDirectory(tmpRoot, 2)
    expect(entries).toHaveLength(2)
    expect(truncated).toBe(true)
  })

  it('accepts existing directories inside the root', () => {
    expect(realpathInsideRoot(tmpRoot, 'sub')).toBe(path.join(fs.realpathSync.native(tmpRoot), 'sub'))
  })

  it('rejects missing paths and parent escapes', () => {
    expect(realpathInsideRoot(tmpRoot, 'missing')).toBeNull()
    expect(realpathInsideRoot(tmpRoot, '..')).toBeNull()
    expect(realpathInsideRoot(tmpRoot, path.join(outside))).toBeNull()
  })

  it.skipIf(!escapeLink)('rejects symlink escapes out of the root', () => {
    expect(realpathInsideRoot(tmpRoot, 'esc')).toBeNull()
    expect(realpathInsideRoot(tmpRoot, 'esc/secret.txt')).toBeNull()
  })
})
