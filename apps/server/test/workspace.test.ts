import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  EMPTY_WORKSPACE,
  MAX_WORKSPACE_ROOTS,
  addRoot,
  deriveRootName,
  findRootForPath,
  formatWorkspacePath,
  normalizeWorkspacePath,
  primaryRoot,
  removeRoot,
  rootByName,
  rootIdFor,
  setPrimaryRoot,
  splitWorkspacePath,
  uniqueRootName,
  workspaceDisplayPath,
  type Workspace
} from '../src/workspace/model.js'
import { parseWorkspace, serializeWorkspace } from '../src/workspace/serialize.js'

/** Build a workspace from absolute paths, in order; the first becomes primary. */
function workspaceOf(...dirs: string[]): Workspace {
  return dirs.reduce<Workspace>((workspace, dir) => {
    const result = addRoot(workspace, { path: dir })
    if (!result.ok) throw new Error(result.error)
    return result.workspace
  }, EMPTY_WORKSPACE)
}

const APP = path.resolve('proj', 'app')
const LIB = path.resolve('proj', 'lib')

describe('deriveRootName', () => {
  it('uses the directory name', () => {
    expect(deriveRootName(path.resolve('code', 'my-app'))).toBe('my-app')
    expect(deriveRootName(path.resolve('code', 'my app'))).toBe('my app')
  })

  it('falls back to the drive/volume label when there is no basename', () => {
    // path.basename('D:\\') is empty, and a bare root still needs a usable name.
    expect(deriveRootName(path.sep)).toBe('root')
    expect(deriveRootName('D:\\')).toBe('D')
  })

  it('strips characters that would break a workspace path segment', () => {
    expect(deriveRootName('/srv/we:ird*name')).toBe('we-ird-name')
  })
})

describe('uniqueRootName', () => {
  it('keeps a free name and suffixes a taken one', () => {
    expect(uniqueRootName('app', [])).toBe('app')
    expect(uniqueRootName('app', ['app'])).toBe('app-2')
    expect(uniqueRootName('app', ['app', 'app-2'])).toBe('app-3')
  })
})

describe('rootIdFor', () => {
  it('is stable for the same directory and differs across directories', () => {
    expect(rootIdFor(APP)).toBe(rootIdFor(APP))
    expect(rootIdFor(APP)).not.toBe(rootIdFor(LIB))
  })
})

describe('addRoot', () => {
  it('makes the first root primary and leaves later roots secondary', () => {
    const workspace = workspaceOf(APP, LIB)
    expect(workspace.roots.map((root) => root.name)).toEqual(['app', 'lib'])
    expect(primaryRoot(workspace)?.name).toBe('app')
  })

  it('is idempotent for a directory that is already a root', () => {
    const workspace = workspaceOf(APP)
    const again = addRoot(workspace, { path: APP })
    expect(again).toMatchObject({ ok: true, added: false })
    if (again.ok) {
      expect(again.workspace.roots).toHaveLength(1)
      expect(again.root.id).toBe(workspace.roots[0].id)
    }
  })

  it('disambiguates a colliding display name', () => {
    const first = path.resolve('one', 'app')
    const second = path.resolve('two', 'app')
    const workspace = workspaceOf(first, second)
    expect(workspace.roots.map((root) => root.name)).toEqual(['app', 'app-2'])
  })

  it('accepts an explicit name and still de-collides it', () => {
    const workspace = workspaceOf(APP)
    const result = addRoot(workspace, { path: LIB, name: 'app' })
    expect(result.ok && result.root.name).toBe('app-2')
  })

  it('rejects a relative path and an empty path', () => {
    expect(addRoot(EMPTY_WORKSPACE, { path: 'relative/dir' })).toMatchObject({ ok: false })
    expect(addRoot(EMPTY_WORKSPACE, { path: '   ' })).toMatchObject({ ok: false })
  })

  it('refuses to grow past the root cap', () => {
    let workspace = EMPTY_WORKSPACE
    for (let i = 0; i < MAX_WORKSPACE_ROOTS; i++) {
      const result = addRoot(workspace, { path: path.resolve('many', `dir${i}`) })
      expect(result.ok).toBe(true)
      if (result.ok) workspace = result.workspace
    }
    expect(addRoot(workspace, { path: path.resolve('many', 'overflow') })).toMatchObject({ ok: false })
  })

  it('never mutates the previous workspace', () => {
    const workspace = workspaceOf(APP)
    addRoot(workspace, { path: LIB })
    expect(workspace.roots).toHaveLength(1)
  })
})

describe('removeRoot', () => {
  it('moves the primary marker to a remaining root', () => {
    const workspace = workspaceOf(APP, LIB)
    const next = removeRoot(workspace, workspace.roots[0].id)
    expect(next.roots.map((root) => root.name)).toEqual(['lib'])
    expect(primaryRoot(next)?.name).toBe('lib')
  })

  it('keeps the primary marker when a secondary root is removed', () => {
    const workspace = workspaceOf(APP, LIB)
    const next = removeRoot(workspace, workspace.roots[1].id)
    expect(primaryRoot(next)?.name).toBe('app')
  })

  it('clears the primary marker once the last root is gone', () => {
    const workspace = workspaceOf(APP)
    expect(removeRoot(workspace, workspace.roots[0].id)).toEqual(EMPTY_WORKSPACE)
  })

  it('ignores an unknown id', () => {
    const workspace = workspaceOf(APP)
    expect(removeRoot(workspace, 'nope')).toBe(workspace)
  })
})

describe('setPrimaryRoot', () => {
  it('switches the primary root', () => {
    const workspace = workspaceOf(APP, LIB)
    expect(primaryRoot(setPrimaryRoot(workspace, workspace.roots[1].id))?.name).toBe('lib')
  })

  it('ignores an unknown id', () => {
    const workspace = workspaceOf(APP, LIB)
    expect(setPrimaryRoot(workspace, 'nope')).toBe(workspace)
  })
})

describe('rootByName', () => {
  it('matches exactly, then case-insensitively', () => {
    const workspace = workspaceOf(APP)
    expect(rootByName(workspace, 'app')?.name).toBe('app')
    expect(rootByName(workspace, 'APP')?.name).toBe('app')
    expect(rootByName(workspace, 'other')).toBeNull()
  })
})

describe('splitWorkspacePath / normalizeWorkspacePath', () => {
  it('normalizes separators, redundant slashes and dot segments', () => {
    expect(normalizeWorkspacePath('app\\src\\\\a.ts')).toBe('app/src/a.ts')
    expect(normalizeWorkspacePath('/app/./src/')).toBe('app/src')
    expect(normalizeWorkspacePath('  ')).toBe('')
    expect(normalizeWorkspacePath('.')).toBe('')
  })

  it('keeps parent segments so containment can reject them', () => {
    expect(normalizeWorkspacePath('app/../../etc')).toBe('app/../../etc')
  })

  it('splits the leading root-name segment from the remainder', () => {
    expect(splitWorkspacePath('app/src/a.ts')).toEqual({ head: 'app', rest: 'src/a.ts' })
    expect(splitWorkspacePath('app')).toEqual({ head: 'app', rest: '' })
    expect(splitWorkspacePath('')).toEqual({ head: '', rest: '' })
  })
})

describe('formatWorkspacePath', () => {
  it('joins a root name with a relative path', () => {
    expect(formatWorkspacePath('app', 'src/a.ts')).toBe('app/src/a.ts')
    expect(formatWorkspacePath('app', '')).toBe('app')
    expect(formatWorkspacePath('app', 'src\\a.ts')).toBe('app/src/a.ts')
  })
})

describe('findRootForPath', () => {
  it('attributes a file to its root', () => {
    const workspace = workspaceOf(APP, LIB)
    expect(findRootForPath(workspace, path.join(LIB, 'src', 'a.ts'))).toMatchObject({ relative: 'src/a.ts' })
  })

  it('prefers the most specific root when roots are nested', () => {
    const inner = path.join(APP, 'packages', 'inner')
    const workspace = workspaceOf(APP, inner)
    const found = findRootForPath(workspace, path.join(inner, 'index.ts'))
    expect(found?.root.name).toBe('inner')
    expect(found?.relative).toBe('index.ts')
  })

  it('returns null for a path outside every root', () => {
    expect(findRootForPath(workspaceOf(APP), path.resolve('elsewhere', 'x.ts'))).toBeNull()
  })
})

describe('workspaceDisplayPath', () => {
  it('qualifies an absolute path with the owning root name', () => {
    const workspace = workspaceOf(APP, LIB)
    expect(workspaceDisplayPath(workspace, path.join(APP, 'src', 'a.ts'))).toBe('app/src/a.ts')
    expect(workspaceDisplayPath(workspace, path.join(LIB, 'b.ts'))).toBe('lib/b.ts')
  })

  it('resolves a relative path against the primary root (OMP reports cwd-relative paths)', () => {
    const workspace = workspaceOf(APP, LIB)
    expect(workspaceDisplayPath(workspace, path.join('src', 'a.ts'))).toBe('app/src/a.ts')
    expect(workspaceDisplayPath(setPrimaryRoot(workspace, workspace.roots[1].id), 'b.ts')).toBe('lib/b.ts')
  })

  it('keeps a path outside every root absolute', () => {
    const outside = path.resolve('elsewhere', 'x.ts')
    expect(workspaceDisplayPath(workspaceOf(APP), outside)).toBe(outside.replace(/\\/g, '/'))
  })

  it('only normalizes separators when no root is configured', () => {
    expect(workspaceDisplayPath(EMPTY_WORKSPACE, 'src\\deep\\a.ts')).toBe('src/deep/a.ts')
  })
})

describe('serializeWorkspace / parseWorkspace', () => {
  it('round-trips a workspace', () => {
    const workspace = workspaceOf(APP, LIB)
    expect(parseWorkspace(serializeWorkspace(workspace))).toEqual(workspace)
  })

  it('returns an empty workspace for missing or corrupt payloads', () => {
    expect(parseWorkspace(null)).toEqual(EMPTY_WORKSPACE)
    expect(parseWorkspace('not json')).toEqual(EMPTY_WORKSPACE)
    expect(parseWorkspace('{"roots":"nope"}')).toEqual(EMPTY_WORKSPACE)
  })

  it('drops malformed roots and repairs a dangling primary id', () => {
    const parsed = parseWorkspace(JSON.stringify({
      roots: [{ id: 'r1', name: 'app', path: APP }, { id: 'r2', name: 'lib' }, 'junk'],
      primaryId: 'gone'
    }))
    expect(parsed.roots.map((root) => root.name)).toEqual(['app'])
    expect(parsed.primaryId).toBe('r1')
  })

  it('drops duplicate paths, ids and names', () => {
    const parsed = parseWorkspace(JSON.stringify({
      roots: [
        { id: 'r1', name: 'app', path: APP },
        { id: 'r2', name: 'other', path: APP },
        { id: 'r1', name: 'dup-id', path: LIB },
        { id: 'r3', name: 'app', path: LIB }
      ],
      primaryId: 'r1'
    }))
    expect(parsed.roots).toHaveLength(1)
    expect(parsed.roots[0]).toMatchObject({ id: 'r1', name: 'app' })
  })

  it('caps a persisted workspace at the root limit', () => {
    const roots = Array.from({ length: MAX_WORKSPACE_ROOTS + 3 }, (_, i) => ({
      id: `r${i}`,
      name: `dir${i}`,
      path: path.resolve('many', `dir${i}`)
    }))
    expect(parseWorkspace(JSON.stringify({ roots, primaryId: 'r0' })).roots).toHaveLength(MAX_WORKSPACE_ROOTS)
  })

  it('migrates the single legacy workdir into a one-root workspace', () => {
    const migrated = parseWorkspace(null, APP)
    expect(migrated.roots).toHaveLength(1)
    expect(primaryRoot(migrated)?.path).toBe(APP)
  })
})
