import { describe, expect, it } from 'vitest'
import { ancestorDirsOf, isRevealed, missingAncestors } from '../src/workspace/reveal'

describe('ancestorDirsOf', () => {
  it('names every directory between the root and the file, outermost first', () => {
    expect(ancestorDirsOf('web/src/editor/tabs.ts')).toEqual(['web', 'web/src', 'web/src/editor'])
  })

  it('stops at the root for a file directly inside one', () => {
    expect(ancestorDirsOf('web/README.md')).toEqual(['web'])
  })

  it('has no ancestors for a root name, the workspace itself, or a path outside it', () => {
    expect(ancestorDirsOf('web')).toEqual([])
    expect(ancestorDirsOf('')).toEqual([])
    expect(ancestorDirsOf('/etc/hosts')).toEqual([])
    expect(ancestorDirsOf('C:/temp/x.ts')).toEqual([])
  })

  it('ignores repeated separators', () => {
    expect(ancestorDirsOf('web//src/x.ts')).toEqual(['web', 'web/src'])
  })
})

describe('missingAncestors', () => {
  it('returns only what still needs listing, outermost first', () => {
    expect(missingAncestors('web/src/editor/tabs.ts', ['web', 'web/src'])).toEqual(['web/src/editor'])
  })

  it('returns nothing once every level is open', () => {
    expect(missingAncestors('web/src/x.ts', ['web', 'web/src'])).toEqual([])
  })

  it('accepts a set as well as a list', () => {
    expect(missingAncestors('web/src/x.ts', new Set(['web']))).toEqual(['web/src'])
  })

  it('ignores unrelated open directories', () => {
    expect(missingAncestors('web/src/x.ts', ['api', 'api/lib'])).toEqual(['web', 'web/src'])
  })
})

describe('isRevealed', () => {
  it('is true when the row is rendered', () => {
    expect(isRevealed('web/src/x.ts', ['web', 'web/src'])).toBe(true)
  })

  it('is false while a level is still collapsed', () => {
    expect(isRevealed('web/src/x.ts', ['web'])).toBe(false)
  })

  it('is false for the workspace itself and for files outside it', () => {
    expect(isRevealed('', [])).toBe(false)
    expect(isRevealed('/etc/hosts', [])).toBe(false)
  })
})
