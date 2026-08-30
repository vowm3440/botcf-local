import { describe, expect, it } from 'vitest'
import type { ChangedFileInfo } from '../src/api'
import { DIFF_CAP, absorbChangedFile, isMutatingToolName, mergeChangedFile, mergeChangedFiles } from '../src/chat/changedFiles'

/** Two sources describe the same changed file — streaming tool frames and the
 *  end-of-turn summary — so merging has to be safe to apply twice and has to stay
 *  bounded across a long session. */

function file(overrides: Partial<ChangedFileInfo> & { path: string }): ChangedFileInfo {
  return { tools: ['Edit'], lastToolCallId: 'call-1', hasDiff: false, isError: false, ...overrides }
}

describe('mergeChangedFile', () => {
  it('unions the tools that touched a file', () => {
    const merged = mergeChangedFile(
      file({ path: 'app/a.ts', tools: ['Write'] }),
      file({ path: 'app/a.ts', tools: ['Edit', 'Write'] })
    )
    expect(merged.tools).toEqual(['Write', 'Edit'])
  })

  it('keeps the newer record for scalar fields', () => {
    const merged = mergeChangedFile(
      file({ path: 'app/a.ts', lastToolCallId: 'call-1', isError: true }),
      file({ path: 'app/a.ts', lastToolCallId: 'call-2', isError: false })
    )
    expect(merged.lastToolCallId).toBe('call-2')
    expect(merged.isError).toBe(false)
  })

  it('joins diffs and keeps hasDiff sticky', () => {
    const merged = mergeChangedFile(
      file({ path: 'app/a.ts', hasDiff: true, diff: 'first' }),
      file({ path: 'app/a.ts', hasDiff: false, diff: 'second' })
    )
    expect(merged.diff).toBe('first\nsecond')
    expect(merged.hasDiff).toBe(true)
  })

  it('leaves diff unset when neither side has one', () => {
    const merged = mergeChangedFile(file({ path: 'app/a.ts' }), file({ path: 'app/a.ts' }))
    expect(merged.diff).toBeUndefined()
  })

  it('caps the accumulated diff, keeping the tail', () => {
    const merged = mergeChangedFile(
      file({ path: 'app/a.ts', diff: 'x'.repeat(DIFF_CAP) }),
      file({ path: 'app/a.ts', diff: 'TAIL' })
    )
    expect(merged.diff).toHaveLength(DIFF_CAP)
    expect(merged.diff?.endsWith('TAIL')).toBe(true)
  })
})

describe('mergeChangedFiles', () => {
  it('collapses to one entry per path in first-seen order', () => {
    const merged = mergeChangedFiles([
      file({ path: 'b.ts', tools: ['Write'] }),
      file({ path: 'a.ts' }),
      file({ path: 'b.ts', tools: ['Edit'] })
    ])
    expect([...merged.keys()]).toEqual(['b.ts', 'a.ts'])
    expect(merged.get('b.ts')?.tools).toEqual(['Write', 'Edit'])
  })

  it('returns an empty map for no input', () => {
    expect(mergeChangedFiles([]).size).toBe(0)
  })
})

describe('absorbChangedFile', () => {
  it('merges into the existing entry without duplicating the path', () => {
    const live = [file({ path: 'a.ts', diff: 'one' }), file({ path: 'b.ts' })]
    const next = absorbChangedFile(live, file({ path: 'a.ts', diff: 'two' }))
    expect(next).toHaveLength(2)
    expect(next.find((entry) => entry.path === 'a.ts')?.diff).toBe('one\ntwo')
  })

  it('appends a path it has not seen and never mutates the input', () => {
    const live = [file({ path: 'a.ts' })]
    const next = absorbChangedFile(live, file({ path: 'b.ts' }))
    expect(next.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts'])
    expect(live).toHaveLength(1)
  })
})

describe('isMutatingToolName', () => {
  it('accepts tools that write files', () => {
    for (const name of ['Edit', 'Write', 'MultiEdit', 'apply_patch', 'create_file', 'rename_file']) {
      expect(isMutatingToolName(name)).toBe(true)
    }
  })

  it('rejects read-only and shell tools even when their name contains a write stem', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'bash', 'run_tests', 'search_replace', 'WebFetch']) {
      expect(isMutatingToolName(name)).toBe(false)
    }
  })
})
