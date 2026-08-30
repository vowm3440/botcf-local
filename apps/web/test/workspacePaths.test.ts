import { describe, expect, it } from 'vitest'
import {
  groupByRoot,
  isOutsideWorkspace,
  isUnderWorkspacePath,
  joinWorkspacePath,
  relativeOf,
  rootNameOf
} from '../src/workspace/paths'

describe('isOutsideWorkspace', () => {
  it('recognises absolute paths as out-of-workspace', () => {
    expect(isOutsideWorkspace('/etc/hosts')).toBe(true)
    expect(isOutsideWorkspace('D:/code/other/x.ts')).toBe(true)
  })

  it('treats qualified workspace paths as inside', () => {
    expect(isOutsideWorkspace('app/src/index.ts')).toBe(false)
    expect(isOutsideWorkspace('app')).toBe(false)
    expect(isOutsideWorkspace('')).toBe(false)
  })
})

describe('rootNameOf / relativeOf', () => {
  it('splits a qualified path into root name and remainder', () => {
    expect(rootNameOf('app/src/index.ts')).toBe('app')
    expect(relativeOf('app/src/index.ts')).toBe('src/index.ts')
  })

  it('handles a bare root name', () => {
    expect(rootNameOf('app')).toBe('app')
    expect(relativeOf('app')).toBe('')
  })

  it('reports no root for the workspace itself and for absolute paths', () => {
    expect(rootNameOf('')).toBe('')
    expect(rootNameOf('/var/log/x')).toBe('')
    expect(relativeOf('/var/log/x')).toBe('')
  })
})

describe('joinWorkspacePath', () => {
  it('joins a root name with a relative path', () => {
    expect(joinWorkspacePath('app', 'src/index.ts')).toBe('app/src/index.ts')
    expect(joinWorkspacePath('app', '')).toBe('app')
    expect(joinWorkspacePath('app', '/src/')).toBe('app/src')
  })
})

describe('isUnderWorkspacePath', () => {
  it('matches a path against itself and its descendants', () => {
    expect(isUnderWorkspacePath('app/src/index.ts', 'app/src')).toBe(true)
    expect(isUnderWorkspacePath('app/src', 'app/src')).toBe(true)
    expect(isUnderWorkspacePath('app/srcx/index.ts', 'app/src')).toBe(false)
    expect(isUnderWorkspacePath('lib/src/index.ts', 'app/src')).toBe(false)
  })

  it('treats the workspace root as containing everything', () => {
    expect(isUnderWorkspacePath('lib/a.ts', '')).toBe(true)
  })
})

describe('groupByRoot', () => {
  it('groups paths by root in first-seen order', () => {
    expect(groupByRoot(['app/a.ts', 'lib/b.ts', 'app/c.ts'])).toEqual([
      { rootName: 'app', paths: ['app/a.ts', 'app/c.ts'] },
      { rootName: 'lib', paths: ['lib/b.ts'] }
    ])
  })

  it('collects out-of-workspace paths under an empty root name', () => {
    expect(groupByRoot(['/tmp/scratch.ts'])).toEqual([{ rootName: '', paths: ['/tmp/scratch.ts'] }])
  })

  it('returns nothing for an empty list', () => {
    expect(groupByRoot([])).toEqual([])
  })
})
