import { describe, expect, it } from 'vitest'
import {
  emptyReviewState,
  forgetPaths,
  listRecords,
  pathsWithDecision,
  recordTurn,
  setDecision,
  summarize,
  trimDiffBudget,
  type ChangedFileLike
} from '../src/review/model.js'

/** Review rules worth pinning down: a decision belongs to a *version* of a file,
 *  so a later edit must send it back to pending; and the stored agent diffs are
 *  bounded, because git is the real source of a diff. */

function changed(path: string, overrides: Partial<ChangedFileLike> = {}): ChangedFileLike {
  return { path, tools: ['write'], hasDiff: true, isError: false, ...overrides }
}

describe('recordTurn', () => {
  it('adds files as pending and numbers the turn', () => {
    const state = recordTurn(emptyReviewState, [changed('app/a.ts'), changed('app/b.ts')], 1_000)
    expect(state.turn).toBe(1)
    expect(listRecords(state).map((record) => [record.path, record.decision, record.turn])).toEqual([
      ['app/a.ts', 'pending', 1],
      ['app/b.ts', 'pending', 1]
    ])
  })

  it('merges tools and keeps the first-seen timestamp across turns', () => {
    const first = recordTurn(emptyReviewState, [changed('app/a.ts', { tools: ['write'] })], 1_000)
    const second = recordTurn(first, [changed('app/a.ts', { tools: ['edit'] })], 2_000)
    const record = second.records.get('app/a.ts')
    expect(record).toMatchObject({ turn: 2, firstAt: 1_000, lastAt: 2_000 })
    expect(record?.tools).toEqual(['write', 'edit'])
  })

  it('resets a decided file back to pending when the agent touches it again', () => {
    const first = recordTurn(emptyReviewState, [changed('app/a.ts')], 1_000)
    const accepted = setDecision(first, ['app/a.ts'], 'accepted', 1_500)
    expect(accepted.records.get('app/a.ts')).toMatchObject({ decision: 'accepted', decidedAt: 1_500 })
    const again = recordTurn(accepted, [changed('app/a.ts')], 2_000)
    expect(again.records.get('app/a.ts')).toMatchObject({ decision: 'pending', decidedAt: null })
  })

  it('keeps the previous diff when a later turn reports none', () => {
    const first = recordTurn(emptyReviewState, [changed('app/a.ts', { diff: '@@ -1 +1 @@' })], 1_000)
    const second = recordTurn(first, [changed('app/a.ts', { diff: undefined, hasDiff: false })], 2_000)
    expect(second.records.get('app/a.ts')).toMatchObject({ diff: '@@ -1 +1 @@', hasDiff: true })
  })

  it('remembers that the last change failed', () => {
    const state = recordTurn(emptyReviewState, [changed('app/a.ts', { isError: true })], 1_000)
    expect(state.records.get('app/a.ts')?.isError).toBe(true)
    expect(summarize(state).failed).toBe(1)
  })

  it('is a no-op for an empty turn', () => {
    const state = recordTurn(emptyReviewState, [], 1_000)
    expect(state).toBe(emptyReviewState)
  })

  it('never mutates the previous state', () => {
    const first = recordTurn(emptyReviewState, [changed('app/a.ts')], 1_000)
    recordTurn(first, [changed('app/b.ts')], 2_000)
    expect(first.records.size).toBe(1)
  })
})

describe('decisions', () => {
  it('lists paths by decision and ignores unknown paths', () => {
    let state = recordTurn(emptyReviewState, [changed('app/a.ts'), changed('app/b.ts')], 1_000)
    state = setDecision(state, ['app/a.ts', 'app/missing.ts'], 'accepted', 2_000)
    expect(pathsWithDecision(state, 'accepted')).toEqual(['app/a.ts'])
    expect(pathsWithDecision(state, 'pending')).toEqual(['app/b.ts'])
  })

  it('forgets committed files entirely', () => {
    let state = recordTurn(emptyReviewState, [changed('app/a.ts'), changed('app/b.ts')], 1_000)
    state = forgetPaths(state, ['app/a.ts'])
    expect(state.records.has('app/a.ts')).toBe(false)
    expect(summarize(state).total).toBe(1)
  })

  it('summarizes the decision mix', () => {
    let state = recordTurn(emptyReviewState, [changed('a/1.ts'), changed('a/2.ts'), changed('a/3.ts')], 1_000)
    state = setDecision(state, ['a/1.ts'], 'accepted', 2_000)
    state = setDecision(state, ['a/2.ts'], 'reverted', 2_000)
    expect(summarize(state)).toMatchObject({ total: 3, pending: 1, accepted: 1, reverted: 1 })
  })
})

describe('listRecords', () => {
  it('sorts newest first', () => {
    let state = recordTurn(emptyReviewState, [changed('a/old.ts')], 1_000)
    state = recordTurn(state, [changed('a/new.ts')], 5_000)
    expect(listRecords(state).map((record) => record.path)).toEqual(['a/new.ts', 'a/old.ts'])
  })
})

describe('trimDiffBudget', () => {
  it('drops the oldest diffs but keeps the records', () => {
    const big = 'x'.repeat(600)
    let state = recordTurn(emptyReviewState, [changed('a/old.ts', { diff: big })], 1_000)
    state = recordTurn(state, [changed('a/new.ts', { diff: big })], 2_000)
    const trimmed = trimDiffBudget(state, 700)
    expect(trimmed.records.get('a/old.ts')?.diff).toBeUndefined()
    expect(trimmed.records.get('a/new.ts')?.diff).toBe(big)
    expect(trimmed.records.size).toBe(2)
    // hasDiff stays true: the change did have a diff, we just stopped storing it.
    expect(trimmed.records.get('a/old.ts')?.hasDiff).toBe(true)
  })

  it('leaves a state within budget untouched', () => {
    const state = recordTurn(emptyReviewState, [changed('a/a.ts', { diff: 'small' })], 1_000)
    expect(trimDiffBudget(state, 1_000)).toBe(state)
  })
})
