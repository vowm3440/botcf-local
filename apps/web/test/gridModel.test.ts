import { describe, expect, it } from 'vitest'
import {
  GridLayout,
  adjustPair,
  dropZoneFor,
  emptyLayout,
  evenLayout,
  findPanel,
  movePanel,
  normalizeLayout,
  panelIds,
  parseStoredLayout,
  resizeColumns,
  resizeRows,
  serializeLayout
} from '../src/layout/gridModel'

/** Two columns: [a] | [b, c] — the canonical 2D fixture. */
function fixture(): GridLayout {
  return {
    columns: [
      { weight: 2, rows: [{ id: 'a', weight: 1 }] },
      { weight: 1, rows: [{ id: 'b', weight: 1 }, { id: 'c', weight: 3 }] }
    ]
  }
}

describe('parseStoredLayout', () => {
  it('round-trips a serialized layout', () => {
    expect(parseStoredLayout(serializeLayout(fixture()))).toEqual(fixture())
  })

  it('migrates the legacy one-row-per-column shape', () => {
    const migrated = parseStoredLayout(JSON.stringify({ order: ['chat', 'editor'], weights: { chat: 3, editor: 2 } }))
    expect(migrated.columns.map((column) => column.weight)).toEqual([3, 2])
    expect(panelIds(migrated)).toEqual(['chat', 'editor'])
  })

  it('returns an empty layout for junk, null and wrong shapes', () => {
    expect(parseStoredLayout(null)).toEqual(emptyLayout())
    expect(parseStoredLayout('not json')).toEqual(emptyLayout())
    expect(parseStoredLayout('[]')).toEqual(emptyLayout())
    expect(parseStoredLayout('{"columns":"nope"}')).toEqual(emptyLayout())
  })

  it('drops malformed rows, columns and weights', () => {
    const parsed = parseStoredLayout(
      JSON.stringify({
        columns: [
          { weight: -4, rows: [{ id: 'a', weight: 0 }, { id: 42 }, null] },
          { weight: 1, rows: [] },
          { rows: [{ id: 'b', weight: 2 }] }
        ]
      })
    )
    expect(parsed.columns).toHaveLength(2)
    expect(parsed.columns[0]).toEqual({ weight: 1, rows: [{ id: 'a', weight: 1 }] })
    expect(parsed.columns[1]).toEqual({ weight: 1, rows: [{ id: 'b', weight: 2 }] })
  })
})

describe('normalizeLayout', () => {
  it('keeps known panels in place and appends unseen ones as columns', () => {
    const normalized = normalizeLayout(fixture(), ['a', 'b', 'c', 'preview'])
    expect(normalized.columns).toHaveLength(3)
    expect(panelIds(normalized)).toEqual(['a', 'b', 'c', 'preview'])
  })

  it('uses the supplied default weight for appended panels', () => {
    const normalized = normalizeLayout(emptyLayout(), ['chat', 'files'], { chat: 3, files: 1 })
    expect(normalized.columns.map((column) => column.weight)).toEqual([3, 1])
  })

  it('drops removed panels and any column left empty', () => {
    const normalized = normalizeLayout(fixture(), ['b', 'c'])
    expect(normalized.columns).toHaveLength(1)
    expect(panelIds(normalized)).toEqual(['b', 'c'])
  })

  it('collapses duplicate ids to their first position', () => {
    const duplicated: GridLayout = {
      columns: [
        { weight: 1, rows: [{ id: 'a', weight: 1 }] },
        { weight: 1, rows: [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }] }
      ]
    }
    expect(panelIds(normalizeLayout(duplicated, ['a', 'b']))).toEqual(['a', 'b'])
  })

  it('does not mutate its input', () => {
    const original = fixture()
    normalizeLayout(original, ['a'])
    expect(original).toEqual(fixture())
  })
})

describe('findPanel', () => {
  it('reports the column and row', () => {
    expect(findPanel(fixture(), 'a')).toEqual({ column: 0, row: 0 })
    expect(findPanel(fixture(), 'c')).toEqual({ column: 1, row: 1 })
    expect(findPanel(fixture(), 'zzz')).toBeNull()
  })
})

describe('adjustPair', () => {
  it('moves weight between the pair and conserves the total', () => {
    expect(adjustPair(2, 2, 0.5, 0.05, 0.05)).toEqual([2.5, 1.5])
  })

  it('clamps at the minimums', () => {
    const [a, b] = adjustPair(2, 2, -5, 0.5, 0.5)
    expect(a).toBeCloseTo(0.5)
    expect(b).toBeCloseTo(3.5)
  })

  it('leaves the pair alone when the minimums fill the space', () => {
    expect(adjustPair(1, 1, 0.4, 1, 1)).toEqual([1, 1])
  })
})

describe('resizeColumns / resizeRows', () => {
  it('resizes neighbouring columns only', () => {
    const resized = resizeColumns(fixture(), 0, 0.5)
    expect(resized.columns[0].weight).toBeCloseTo(2.5)
    expect(resized.columns[1].weight).toBeCloseTo(0.5)
    expect(resized.columns[1].rows).toEqual(fixture().columns[1].rows)
  })

  it('resizes neighbouring rows inside one column', () => {
    const resized = resizeRows(fixture(), 1, 0, 1)
    expect(resized.columns[1].rows[0].weight).toBeCloseTo(2)
    expect(resized.columns[1].rows[1].weight).toBeCloseTo(2)
    expect(resized.columns[0]).toEqual(fixture().columns[0])
  })

  it('ignores out-of-range gutters', () => {
    expect(resizeColumns(fixture(), 5, 1)).toEqual(fixture())
    expect(resizeRows(fixture(), 0, 0, 1)).toEqual(fixture())
    expect(resizeRows(fixture(), 9, 0, 1)).toEqual(fixture())
  })
})

describe('movePanel', () => {
  it('stacks a panel below the target inside its column', () => {
    const moved = movePanel(fixture(), 'a', 'b', 'bottom')
    expect(moved.columns).toHaveLength(1)
    expect(moved.columns[0].rows.map((row) => row.id)).toEqual(['b', 'a', 'c'])
  })

  it('stacks above the target for the top zone', () => {
    const moved = movePanel(fixture(), 'a', 'c', 'top')
    expect(moved.columns[0].rows.map((row) => row.id)).toEqual(['b', 'a', 'c'])
  })

  it('splits out a new column on the requested side', () => {
    const right = movePanel(fixture(), 'c', 'a', 'right')
    expect(right.columns.map((column) => column.rows.map((row) => row.id))).toEqual([['a'], ['c'], ['b']])
    const left = movePanel(fixture(), 'c', 'a', 'left')
    expect(left.columns.map((column) => column.rows.map((row) => row.id))).toEqual([['c'], ['a'], ['b']])
  })

  it('halves the target column weight when splitting', () => {
    const moved = movePanel(fixture(), 'c', 'a', 'right')
    expect(moved.columns[0].weight).toBeCloseTo(1)
    expect(moved.columns[1].weight).toBeCloseTo(1)
  })

  it('drops the source column once it empties', () => {
    const moved = movePanel(fixture(), 'a', 'b', 'top')
    expect(moved.columns).toHaveLength(1)
  })

  it('is a no-op for unknown ids or self-drops', () => {
    expect(movePanel(fixture(), 'a', 'a', 'left')).toEqual(fixture())
    expect(movePanel(fixture(), 'zzz', 'a', 'left')).toEqual(fixture())
    expect(movePanel(fixture(), 'a', 'zzz', 'left')).toEqual(fixture())
  })

  it('does not mutate its input', () => {
    const original = fixture()
    movePanel(original, 'a', 'c', 'bottom')
    expect(original).toEqual(fixture())
  })
})

describe('dropZoneFor', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 }

  it('splits the panel along its diagonals', () => {
    expect(dropZoneFor(5, 50, rect)).toBe('left')
    expect(dropZoneFor(95, 50, rect)).toBe('right')
    expect(dropZoneFor(50, 5, rect)).toBe('top')
    expect(dropZoneFor(50, 95, rect)).toBe('bottom')
  })

  it('handles an offset rect and a degenerate size', () => {
    expect(dropZoneFor(210, 150, { left: 200, top: 100, width: 100, height: 100 })).toBe('left')
    expect(dropZoneFor(0, 0, { left: 0, top: 0, width: 0, height: 0 })).toBe('left')
  })
})

describe('evenLayout', () => {
  it('resets every column and row weight', () => {
    const even = evenLayout(fixture())
    expect(even.columns.every((column) => column.weight === 1)).toBe(true)
    expect(even.columns.flatMap((column) => column.rows).every((row) => row.weight === 1)).toBe(true)
  })
})
