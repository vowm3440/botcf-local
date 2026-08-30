import { describe, expect, it } from 'vitest'
import { buildInlineRows } from '../src/editor/inlineRows'
import type { EditRegion } from '../src/editor/editRegions'

function region(overrides: Partial<EditRegion> = {}): EditRegion {
  return {
    kind: 'modify',
    start: 2,
    count: 1,
    added: 1,
    removed: 1,
    addedText: ['BETA'],
    removedText: ['beta'],
    ...overrides
  }
}

function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`)
}

describe('buildInlineRows', () => {
  it('puts the removed line back above the line that replaced it', () => {
    const rows = buildInlineRows(['alpha', 'BETA', 'gamma'], [region()])
    expect(rows.map((row) => [row.kind, row.line, row.text])).toEqual([
      ['context', 1, 'alpha'],
      ['removed', null, 'beta'],
      ['added', 2, 'BETA'],
      ['context', 3, 'gamma']
    ])
  })

  it('pairs a one-for-one replacement so the changed words can be emphasized', () => {
    const rows = buildInlineRows(['alpha', 'BETA', 'gamma'], [region()])
    expect(rows.find((row) => row.kind === 'removed')?.paired).toBe('BETA')
    expect(rows.find((row) => row.kind === 'added')?.paired).toBe('beta')
  })

  it('leaves the unpaired half of an uneven replacement without a counterpart', () => {
    const rows = buildInlineRows(
      ['alpha', 'ONE', 'gamma'],
      [region({ start: 2, count: 1, added: 1, removed: 2, addedText: ['ONE'], removedText: ['x', 'y'] })]
    )
    const removed = rows.filter((row) => row.kind === 'removed')
    expect(removed.map((row) => row.paired)).toEqual(['ONE', undefined])
  })

  it('collapses the unchanged stretches into one row that counts them', () => {
    const rows = buildInlineRows(numbered(20), [region({ start: 10, addedText: ['line 10'], removedText: ['old'] })], { context: 1 })
    expect(rows.map((row) => row.kind)).toEqual(['gap', 'context', 'removed', 'added', 'context', 'gap'])
    expect(rows.filter((row) => row.kind === 'gap').map((row) => row.skipped)).toEqual([8, 9])
  })

  it('renders every line when asked, with no gaps', () => {
    const rows = buildInlineRows(numbered(20), [region({ start: 10, addedText: ['line 10'], removedText: ['old'] })], { full: true })
    expect(rows.filter((row) => row.kind === 'gap')).toEqual([])
    expect(rows.filter((row) => row.line !== null)).toHaveLength(20)
  })

  it('merges the windows of two regions that are closer than the context', () => {
    const lines = numbered(20)
    const rows = buildInlineRows(
      lines,
      [
        region({ start: 8, addedText: ['line 8'], removedText: ['a'] }),
        region({ start: 11, addedText: ['line 11'], removedText: ['b'] })
      ],
      { context: 3 }
    )
    expect(rows.filter((row) => row.kind === 'gap')).toHaveLength(2)
    expect(rows.filter((row) => row.kind === 'context').map((row) => row.line)).toEqual([5, 6, 7, 9, 10, 12, 13, 14])
  })

  it('shows a deletion that happened past the last line', () => {
    const rows = buildInlineRows(
      ['a', 'b'],
      [region({ kind: 'delete', start: 3, count: 0, added: 0, addedText: [], removed: 1, removedText: ['c'] })]
    )
    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ['context', 'a'],
      ['context', 'b'],
      ['removed', 'c']
    ])
  })

  it('ignores a region that starts beyond the end of the file', () => {
    const rows = buildInlineRows(['a'], [region({ start: 99, addedText: ['gone'] })])
    expect(rows).toEqual([{ kind: 'gap', line: null, text: '', skipped: 1 }])
  })

  it('shows the file unchanged when there is nothing to mark', () => {
    expect(buildInlineRows(['a', 'b'], [])).toEqual([
      { kind: 'gap', line: null, text: '', skipped: 2 }
    ])
  })

  it('handles an empty file', () => {
    expect(buildInlineRows([], [])).toEqual([])
  })
})
