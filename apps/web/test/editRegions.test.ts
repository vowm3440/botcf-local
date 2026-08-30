import { describe, expect, it } from 'vitest'
import {
  anchorRegions,
  applyAnchors,
  buildDiffCounts,
  countDiffLines,
  hasStaleRegions,
  mergeRegions,
  nextRegion,
  parseEditRegions,
  previousRegion,
  regionEnd,
  totalDiffCounts,
  trackEdits,
  type EditRegion
} from '../src/editor/editRegions'

function region(overrides: Partial<EditRegion> = {}): EditRegion {
  return {
    kind: 'add',
    start: 1,
    count: 1,
    added: 1,
    removed: 0,
    addedText: ['x'],
    removedText: [],
    ...overrides
  }
}

describe('parseEditRegions', () => {
  it('reads a replacement as one modify region in new-file coordinates', () => {
    const parsed = parseEditRegions(['@@ -1,3 +1,3 @@', ' alpha', '-beta', '+BETA', ' gamma'].join('\n'))
    expect(parsed.regions).toEqual([
      { kind: 'modify', start: 2, count: 1, added: 1, removed: 1, addedText: ['BETA'], removedText: ['beta'] }
    ])
    expect(parsed).toMatchObject({ added: 1, removed: 1, approximate: false })
  })

  it('reads an insertion', () => {
    const parsed = parseEditRegions(['@@ -0,0 +1,2 @@', '+one', '+two'].join('\n'))
    expect(parsed.regions).toEqual([
      { kind: 'add', start: 1, count: 2, added: 2, removed: 0, addedText: ['one', 'two'], removedText: [] }
    ])
  })

  it('anchors a deletion on the line that took its place, occupying none', () => {
    const parsed = parseEditRegions(['@@ -1,3 +1,2 @@', ' alpha', '-beta', ' gamma'].join('\n'))
    expect(parsed.regions).toEqual([
      { kind: 'delete', start: 2, count: 0, added: 0, removed: 1, addedText: [], removedText: ['beta'] }
    ])
    expect(regionEnd(parsed.regions[0])).toBe(1)
  })

  it('keeps two hunks apart and counts both', () => {
    const parsed = parseEditRegions(
      ['@@ -1,2 +1,2 @@', '-a', '+A', ' b', '@@ -20,2 +20,2 @@', ' t', '-u', '+U'].join('\n')
    )
    expect(parsed.regions.map((entry) => entry.start)).toEqual([1, 21])
    expect(parsed).toMatchObject({ added: 2, removed: 2, approximate: false })
  })

  it('treats file headers as metadata, not as content', () => {
    const parsed = parseEditRegions(
      ['diff --git a/x.ts b/x.ts', 'index 111..222 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n')
    )
    expect(parsed.regions).toHaveLength(1)
    expect(parsed).toMatchObject({ added: 1, removed: 1 })
  })

  it('infers line numbers for a hunkless tool diff and says so', () => {
    const parsed = parseEditRegions(['-old', '+new'].join('\n'))
    expect(parsed.regions[0]).toMatchObject({ kind: 'modify', start: 1, count: 1 })
    expect(parsed.approximate).toBe(true)
  })

  it('marks concatenated diffs for the same file as approximate', () => {
    const parsed = parseEditRegions(
      ['@@ -1,1 +1,1 @@', '-a', '+A', '--- x', '+++ x', '@@ -5,1 +5,1 @@', '-e', '+E'].join('\n')
    )
    expect(parsed.regions.map((entry) => entry.start)).toEqual([1, 5])
    expect(parsed.approximate).toBe(true)
  })

  it('does not mistake added content that looks like a header', () => {
    const parsed = parseEditRegions(['@@ -1,1 +1,2 @@', ' keep', '+++ a bullet list item'].join('\n'))
    expect(parsed.regions).toEqual([
      { kind: 'add', start: 2, count: 1, added: 1, removed: 0, addedText: ['++ a bullet list item'], removedText: [] }
    ])
  })

  it('ignores the no-newline marker without consuming a line number', () => {
    const parsed = parseEditRegions(['@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+B'].join('\n'))
    expect(parsed.regions).toEqual([
      { kind: 'modify', start: 2, count: 1, added: 1, removed: 1, addedText: ['B'], removedText: ['b'] }
    ])
  })

  it('returns nothing for empty input', () => {
    expect(parseEditRegions('')).toMatchObject({ regions: [], added: 0, removed: 0 })
  })
})

describe('countDiffLines', () => {
  it('counts changed lines without reading regions', () => {
    expect(countDiffLines(['@@ -1,2 +1,3 @@', '-a', '+A', '+B'].join('\n'))).toEqual({ added: 2, removed: 1 })
  })

  it('skips file headers', () => {
    expect(countDiffLines(['--- a/x', '+++ b/x', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n'))).toEqual({ added: 1, removed: 1 })
  })

  it('handles a missing diff', () => {
    expect(countDiffLines(undefined)).toEqual({ added: 0, removed: 0 })
  })
})

describe('anchorRegions', () => {
  const lines = ['alpha', 'BETA', 'gamma']

  it('keeps a region whose added text is where the diff said', () => {
    const anchored = anchorRegions([region({ kind: 'modify', start: 2, addedText: ['BETA'], removed: 1, removedText: ['beta'] })], lines)
    expect(anchored.map((entry) => entry.start)).toEqual([2])
  })

  it('shifts a region whose text moved down the file', () => {
    const moved = ['x', 'y', 'alpha', 'BETA', 'gamma']
    const anchored = anchorRegions([region({ start: 2, addedText: ['BETA'] })], moved)
    expect(anchored.map((entry) => entry.start)).toEqual([4])
  })

  it('drops a region whose text is gone rather than drawing it at a stale line', () => {
    expect(anchorRegions([region({ start: 2, addedText: ['BETA'] })], ['alpha', 'other', 'gamma'])).toEqual([])
  })

  it('refuses to search for an all-blank block, which would match anywhere', () => {
    expect(anchorRegions([region({ start: 1, count: 2, added: 2, addedText: ['', ''] })], ['a', '', ''])).toEqual([])
    const matched = anchorRegions([region({ start: 1, count: 2, added: 2, addedText: ['', ''] })], ['', '', 'a'])
    expect(matched).toHaveLength(1)
  })

  it('respects the search window', () => {
    const far = ['a', 'b', 'c', 'BETA']
    expect(anchorRegions([region({ start: 1, addedText: ['BETA'] })], far, { window: 1 })).toEqual([])
    expect(anchorRegions([region({ start: 1, addedText: ['BETA'] })], far, { window: 3 })).toHaveLength(1)
  })

  it('keeps a deletion, clamped into the file', () => {
    const deletion = region({ kind: 'delete', start: 99, count: 0, added: 0, addedText: [], removed: 1, removedText: ['gone'] })
    expect(anchorRegions([deletion], lines)[0]).toMatchObject({ start: 4, count: 0 })
  })

  it('drops a block that no longer fits in the file', () => {
    expect(anchorRegions([region({ start: 1, count: 2, added: 2, addedText: ['alpha', 'BETA'] })], ['alpha'])).toEqual([])
  })

  it('sorts the result by position', () => {
    const anchored = anchorRegions(
      [region({ start: 3, addedText: ['gamma'] }), region({ start: 1, addedText: ['alpha'] })],
      lines
    )
    expect(anchored.map((entry) => entry.start)).toEqual([1, 3])
  })
})

describe('mergeRegions', () => {
  it('folds abutting regions and keeps their text', () => {
    const merged = mergeRegions([
      region({ start: 1, count: 2, added: 2, addedText: ['a', 'b'] }),
      region({ start: 3, count: 1, added: 1, addedText: ['c'] })
    ])
    expect(merged).toEqual([
      { kind: 'add', start: 1, count: 3, added: 3, removed: 0, addedText: ['a', 'b', 'c'], removedText: [] }
    ])
  })

  it('leaves a gap between regions alone', () => {
    const merged = mergeRegions([region({ start: 1 }), region({ start: 5 })])
    expect(merged).toHaveLength(2)
  })

  it('drops the added text of an overlapping merge, which it cannot describe', () => {
    const merged = mergeRegions([
      region({ start: 1, count: 3, added: 3, addedText: ['a', 'b', 'c'] }),
      region({ start: 2, count: 2, added: 2, addedText: ['B', 'C'] })
    ])
    expect(merged[0]).toMatchObject({ start: 1, count: 3, added: 5, addedText: [] })
  })

  it('becomes a modification when an addition and a deletion meet', () => {
    const merged = mergeRegions([
      region({ start: 4, count: 1, added: 1, addedText: ['new'] }),
      region({ kind: 'delete', start: 5, count: 0, added: 0, addedText: [], removed: 2, removedText: ['x', 'y'] })
    ])
    expect(merged[0]).toMatchObject({ kind: 'modify', start: 4, count: 1, added: 1, removed: 2 })
    expect(merged[0].removedText).toEqual(['x', 'y'])
  })
})

describe('trackEdits', () => {
  it('parses, anchors and folds in one call', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' alpha', '-beta', '+BETA', ' gamma'].join('\n')
    const tracked = trackEdits(diff, ['alpha', 'BETA', 'gamma'])
    expect(tracked.regions).toHaveLength(1)
    expect(tracked).toMatchObject({ added: 1, removed: 1, approximate: false })
  })

  it('re-seats a diff whose line numbers a later edit invalidated', () => {
    const diff = ['@@ -1,1 +1,1 @@', '-beta', '+BETA'].join('\n')
    const tracked = trackEdits(diff, ['inserted', 'inserted', 'BETA'])
    expect(tracked.regions[0]).toMatchObject({ start: 3, count: 1 })
  })

  it('reports nothing for a file the diff no longer describes', () => {
    const diff = ['@@ -1,1 +1,1 @@', '-beta', '+BETA'].join('\n')
    expect(trackEdits(diff, ['unrelated']).regions).toEqual([])
  })

  it('has nothing to track without a diff', () => {
    expect(trackEdits(undefined, ['a'])).toMatchObject({ regions: [], added: 0, removed: 0 })
  })

  it('keeps the approximate flag through anchoring', () => {
    expect(trackEdits(['-old', '+new'].join('\n'), ['new']).approximate).toBe(true)
  })
})

describe('hasStaleRegions', () => {
  it('is true once anchoring loses part of the reported change', () => {
    const diff = ['@@ -1,2 +1,2 @@', '-a', '+A', ' keep', '@@ -9,2 +9,2 @@', '-b', '+B'].join('\n')
    const parsed = parseEditRegions(diff)
    const anchored = applyAnchors(parsed, ['A', 'keep'])
    expect(anchored.regions).toHaveLength(1)
    expect(hasStaleRegions(parsed, anchored)).toBe(true)
  })

  it('is false when everything was found', () => {
    const parsed = parseEditRegions(['@@ -1,1 +1,1 @@', '-a', '+A'].join('\n'))
    expect(hasStaleRegions(parsed, applyAnchors(parsed, ['A']))).toBe(false)
  })
})

describe('region navigation', () => {
  const regions = [region({ start: 2 }), region({ start: 10 })]

  it('walks forward and wraps', () => {
    expect(nextRegion(regions, 1)?.start).toBe(2)
    expect(nextRegion(regions, 2)?.start).toBe(10)
    expect(nextRegion(regions, 10)?.start).toBe(2)
  })

  it('walks backward and wraps', () => {
    expect(previousRegion(regions, 10)?.start).toBe(2)
    expect(previousRegion(regions, 2)?.start).toBe(10)
  })

  it('has nowhere to go with no regions', () => {
    expect(nextRegion([], 1)).toBeNull()
    expect(previousRegion([], 1)).toBeNull()
  })
})

describe('buildDiffCounts', () => {
  it('indexes only the paths that actually changed lines', () => {
    const counts = buildDiffCounts([
      { path: 'web/a.ts', diff: ['@@ -1,1 +1,2 @@', '-a', '+A', '+B'].join('\n') },
      { path: 'web/b.ts' },
      { path: 'web/c.ts', diff: '--- a/c\n+++ b/c' }
    ])
    expect([...counts.keys()]).toEqual(['web/a.ts'])
    expect(counts.get('web/a.ts')).toEqual({ added: 2, removed: 1 })
  })

  it('totals a session', () => {
    expect(totalDiffCounts([{ added: 2, removed: 1 }, { added: 5, removed: 0 }])).toEqual({ added: 7, removed: 1 })
    expect(totalDiffCounts([])).toEqual({ added: 0, removed: 0 })
  })
})
