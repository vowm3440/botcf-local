import { describe, expect, it } from 'vitest'
import {
  FRAME_SHARE,
  activatePart,
  adjustPair,
  dockBesideGroup,
  dockIntoGroup,
  dockToFrame,
  evenSplit,
  findGroup,
  freshGroupId,
  groupEntries,
  largestGroup,
  locatePart,
  makeGroup,
  makeSplit,
  minExtent,
  nodeAt,
  normalizeDock,
  openParts,
  parseDockNode,
  removePart,
  reorderPart,
  resizeSplit,
  type DockNode
} from '../src/dock/dockModel'

/** The dock tree is the one thing in the layout that has no visual fallback: if it
 *  is wrong, panes vanish, stack in the wrong order or hold space nothing can fill.
 *  All of it is pure, so all of it is pinned down here rather than in a browser. */

const KNOWN = ['explorer', 'scm', 'editor', 'terminal', 'chat', 'problems']

/** Three columns, the middle one split in two — the shape most layouts land in. */
function sample(): DockNode {
  return makeSplit('x', [
    makeGroup('left', ['explorer', 'scm'], 'explorer', 0.2),
    makeSplit('y', [makeGroup('center', ['editor'], 'editor', 0.7), makeGroup('bottom', ['terminal'], 'terminal', 0.3)], 0.5),
    makeGroup('right', ['chat'], 'chat', 0.3)
  ])
}

function weightsOf(node: DockNode, path: readonly number[] = []): number[] {
  const split = nodeAt(node, path)
  if (!split || split.kind !== 'split') return []
  return split.children.map((child) => child.weight)
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

describe('reading the tree', () => {
  it('lists every group in document order with its share of the frame', () => {
    const entries = groupEntries(sample())
    expect(entries.map((entry) => entry.group.id)).toEqual(['left', 'center', 'bottom', 'right'])
    // Area is the product of the weights down to the group, so a nested pane
    // reports the fraction of the *frame* it covers, not of its parent.
    expect(entries[1].area).toBeCloseTo(0.5 * 0.7)
    expect(entries[2].area).toBeCloseTo(0.5 * 0.3)
    expect(sum(entries.map((entry) => entry.area))).toBeCloseTo(1)
  })

  it('finds parts, groups and the biggest pane', () => {
    const tree = sample()
    expect(locatePart(tree, 'scm')).toMatchObject({ index: 1 })
    expect(locatePart(tree, 'scm')?.group.id).toBe('left')
    expect(locatePart(tree, 'nothing')).toBeNull()
    expect(findGroup(tree, 'bottom')?.path).toEqual([1, 1])
    expect(largestGroup(tree).group.id).toBe('center')
    expect(openParts(tree)).toEqual(['explorer', 'scm', 'editor', 'terminal', 'chat'])
    expect(openParts(null)).toEqual([])
  })

  it('generates group ids that never collide with the ones in use', () => {
    expect(freshGroupId(null)).toBe('g1')
    expect(freshGroupId(sample())).toBe('g1')
    expect(freshGroupId(makeSplit('x', [makeGroup('g7', ['a']), makeGroup('g2', ['b'])]))).toBe('g8')
  })
})

describe('closing parts', () => {
  it('selects the neighbour on the right, or the left one when it was last', () => {
    const group = makeGroup('g1', ['a', 'b', 'c'], 'b')
    expect((removePart(group, 'b') as typeof group).active).toBe('c')
    const last = makeGroup('g1', ['a', 'b', 'c'], 'c')
    expect((removePart(last, 'c') as typeof group).active).toBe('b')
  })

  it('leaves an untouched active tab alone', () => {
    const group = makeGroup('g1', ['a', 'b', 'c'], 'a')
    expect((removePart(group, 'c') as typeof group).active).toBe('a')
  })

  it('collapses the group it emptied, and the split that is left with one child', () => {
    const closed = removePart(sample(), 'terminal')
    expect(closed && groupEntries(closed).map((entry) => entry.group.id)).toEqual(['left', 'center', 'right'])
    // The centre column collapsed into the editor group, which inherited its share.
    expect(closed && findGroup(closed, 'center')?.path).toEqual([1])
    expect(closed && weightsOf(closed)[1]).toBeCloseTo(0.5)
  })

  it('reports an empty frame rather than an empty tree', () => {
    expect(removePart(makeGroup('g1', ['editor']), 'editor')).toBeNull()
  })

  it('ignores a part that is not open', () => {
    const tree = sample()
    expect(removePart(tree, 'problems')).toBe(tree)
  })
})

describe('tabs', () => {
  it('activates without touching anything else', () => {
    const tree = sample()
    expect(locatePart(activatePart(tree, 'scm'), 'scm')?.group.active).toBe('scm')
    expect(activatePart(tree, 'explorer')).toBe(tree)
    expect(activatePart(tree, 'nothing')).toBe(tree)
  })

  it('reorders by naming the tab to land before, or null for last', () => {
    const tree = makeGroup('g1', ['a', 'b', 'c'], 'a')
    expect((reorderPart(tree, 'g1', 'c', 'a') as typeof tree).parts).toEqual(['c', 'a', 'b'])
    expect((reorderPart(tree, 'g1', 'a', null) as typeof tree).parts).toEqual(['b', 'c', 'a'])
    expect(reorderPart(tree, 'g1', 'a', 'a')).toBe(tree)
    expect(reorderPart(tree, 'g1', 'missing', null)).toBe(tree)
  })

  it('moves a part into another group and gives it focus', () => {
    const moved = dockIntoGroup(sample(), 'terminal', 'left', 'scm')
    expect(findGroup(moved, 'left')?.group.parts).toEqual(['explorer', 'terminal', 'scm'])
    expect(findGroup(moved, 'left')?.group.active).toBe('terminal')
    // Its old group was emptied, so the centre column collapsed with it.
    expect(findGroup(moved, 'bottom')).toBeNull()
    expect(groupEntries(moved).map((entry) => entry.group.id)).toEqual(['left', 'center', 'right'])
  })

  it('treats a drop into the group a part is already in as a reorder', () => {
    const tree = sample()
    expect(dockIntoGroup(tree, 'scm', 'left', null).kind).toBe('split')
    expect(findGroup(dockIntoGroup(tree, 'scm', 'left', 'explorer'), 'left')?.group.parts).toEqual(['scm', 'explorer'])
    expect(dockIntoGroup(tree, 'explorer', 'left')).toBe(activatePart(tree, 'explorer'))
  })

  it('can open a part that is not in the tree yet', () => {
    const opened = dockIntoGroup(sample(), 'problems', 'bottom')
    expect(findGroup(opened, 'bottom')?.group.parts).toEqual(['terminal', 'problems'])
    expect(findGroup(opened, 'bottom')?.group.active).toBe('problems')
  })
})

describe('docking beside a group', () => {
  it('splits the target and takes the space from it alone', () => {
    const docked = dockBesideGroup(sample(), 'chat', 'center', 'bottom')
    // The centre column is now editor over chat, over the terminal…
    expect(groupEntries(docked).map((entry) => entry.group.id)).toEqual(['left', 'center', 'g1', 'bottom'])
    // …the right column is gone, so the left and centre keep their shares…
    expect(weightsOf(docked)).toEqual([0.2, 0.5])
    // …and the editor gave up half of its own share, nothing else moved.
    expect(weightsOf(docked, [1, 0])).toEqual([0.35, 0.35])
    // The raw operation nests a same-axis split; flattening it is normalizing's job.
    expect(weightsOf(normalizeDock(docked, KNOWN) as DockNode, [1])).toEqual([0.35, 0.35, 0.3])
  })

  it('puts a leading edge before its neighbour and a trailing edge after', () => {
    const left = dockBesideGroup(sample(), 'chat', 'center', 'left')
    expect(groupEntries(left).map((entry) => entry.group.id)).toEqual(['left', 'g1', 'center', 'bottom'])
    const right = dockBesideGroup(sample(), 'chat', 'center', 'right')
    expect(groupEntries(right).map((entry) => entry.group.id)).toEqual(['left', 'center', 'g1', 'bottom'])
  })

  it('refuses to dock a lone part beside itself', () => {
    const tree = sample()
    expect(dockBesideGroup(tree, 'chat', 'right', 'left')).toBe(tree)
    // With a neighbour in the group it is a real move, not a no-op.
    expect(dockBesideGroup(tree, 'scm', 'left', 'left')).not.toBe(tree)
  })

  it('halves the target rather than the whole row', () => {
    const docked = dockBesideGroup(sample(), 'problems', 'right', 'right')
    const [leftShare, centreShare] = weightsOf(docked)
    expect(leftShare).toBeCloseTo(0.2)
    expect(centreShare).toBeCloseTo(0.5)
    expect(weightsOf(docked, [2])).toEqual([0.15, 0.15])
  })
})

describe('docking to the frame', () => {
  it('extends a split that already runs along that axis instead of nesting one', () => {
    const docked = dockToFrame(sample(), 'problems', 'right')
    expect(docked.kind).toBe('split')
    expect((docked as { children: readonly DockNode[] }).children).toHaveLength(4)
    expect(groupEntries(docked).map((entry) => entry.group.id)).toEqual(['left', 'center', 'bottom', 'right', 'g1'])
    expect(sum(weightsOf(docked))).toBeCloseTo(1)
    expect(weightsOf(docked)[3]).toBeCloseTo(FRAME_SHARE)
  })

  it('wraps the whole frame when the axis is new', () => {
    const docked = dockToFrame(sample(), 'problems', 'bottom')
    expect(docked).toMatchObject({ kind: 'split', axis: 'y' })
    expect(weightsOf(docked)).toEqual([1 - FRAME_SHARE, FRAME_SHARE])
    expect(nodeAt(docked, [0])).toMatchObject({ kind: 'split', axis: 'x' })
  })

  it('puts a leading edge first', () => {
    const docked = dockToFrame(sample(), 'problems', 'top')
    expect(groupEntries(docked)[0].group.parts).toEqual(['problems'])
  })

  it('takes the part out of wherever it was', () => {
    const docked = dockToFrame(sample(), 'terminal', 'left')
    expect(openParts(docked).filter((part) => part === 'terminal')).toHaveLength(1)
    expect(findGroup(docked, 'bottom')).toBeNull()
  })

  it('makes the part the whole frame when it was the only one', () => {
    expect(dockToFrame(makeGroup('g1', ['editor']), 'editor', 'left')).toMatchObject({
      kind: 'group',
      parts: ['editor'],
      weight: 1
    })
  })
})

describe('resizing', () => {
  it('moves share between two panes and never changes their total', () => {
    const resized = resizeSplit(sample(), [], 0, 0.1)
    const [left, centre, right] = weightsOf(resized)
    expect(left).toBeCloseTo(0.3)
    expect(centre).toBeCloseTo(0.4)
    expect(right).toBeCloseTo(0.3)
  })

  it('stops at the minimums instead of squeezing a pane to nothing', () => {
    const resized = resizeSplit(sample(), [], 0, 5, 0.1, 0.25)
    const [left, centre] = weightsOf(resized)
    expect(centre).toBeCloseTo(0.25)
    expect(left).toBeCloseTo(0.45)
  })

  it('gives up when the two minimums do not fit', () => {
    expect(adjustPair(0.5, 0.5, 0.2, 0.8, 0.8)).toEqual([0.5, 0.5])
  })

  it('keeps a floor even when a part claims no minimum', () => {
    const [left] = adjustPair(0.5, 0.5, -10, 0, 0)
    expect(left).toBeCloseTo(0.04)
  })

  it('ignores a path that is not a split, or a pair that does not exist', () => {
    const tree = sample()
    expect(resizeSplit(tree, [0], 0, 0.1)).toBe(tree)
    expect(resizeSplit(tree, [], 5, 0.1)).toBe(tree)
  })

  it('evens one container and leaves the rest alone', () => {
    const evened = evenSplit(sample(), [])
    expect(weightsOf(evened).map((value) => Number(value.toFixed(4)))).toEqual([0.3333, 0.3333, 0.3333])
    expect(weightsOf(evened, [1])).toEqual([0.7, 0.3])
  })
})

describe('minimum extents', () => {
  const minOf = (part: string): number => (part === 'editor' ? 300 : 100)

  it('adds up along the axis and competes across it', () => {
    const column = makeSplit('y', [makeGroup('a', ['editor']), makeGroup('b', ['chat'])])
    expect(minExtent(column, 'y', minOf)).toBe(400)
    expect(minExtent(column, 'x', minOf)).toBe(300)
  })

  it('takes the largest minimum among tabs sharing a group', () => {
    expect(minExtent(makeGroup('a', ['chat', 'editor']), 'x', minOf)).toBe(300)
  })
})

describe('normalizing', () => {
  it('drops parts that no longer exist and keeps the first of a duplicate', () => {
    const tree = makeSplit('x', [
      makeGroup('left', ['explorer', 'gone'], 'gone', 1),
      makeGroup('right', ['explorer', 'chat'], 'chat', 1)
    ])
    const normalized = normalizeDock(tree, KNOWN)
    expect(normalized && findGroup(normalized, 'left')?.group).toMatchObject({
      parts: ['explorer'],
      active: 'explorer'
    })
    expect(normalized && findGroup(normalized, 'right')?.group.parts).toEqual(['chat'])
  })

  it('removes groups that ended up empty and collapses their container', () => {
    const tree = makeSplit('x', [makeGroup('a', ['gone']), makeGroup('b', ['editor'])])
    expect(normalizeDock(tree, KNOWN)).toMatchObject({ kind: 'group', parts: ['editor'], weight: 1 })
  })

  it('folds a nested split that runs along the same axis as its parent', () => {
    const tree = makeSplit('x', [
      makeGroup('a', ['explorer'], 'explorer', 0.5),
      makeSplit('x', [makeGroup('b', ['editor'], 'editor', 0.5), makeGroup('c', ['chat'], 'chat', 0.5)], 0.5)
    ])
    const normalized = normalizeDock(tree, KNOWN)
    expect(normalized).toMatchObject({ kind: 'split', axis: 'x' })
    expect(weightsOf(normalized as DockNode)).toEqual([0.5, 0.25, 0.25])
  })

  it('keeps a nested split that runs the other way', () => {
    const normalized = normalizeDock(sample(), KNOWN)
    expect(nodeAt(normalized as DockNode, [1])).toMatchObject({ kind: 'split', axis: 'y' })
  })

  it('rescales every set of siblings to sum to one', () => {
    const tree = makeSplit('x', [makeGroup('a', ['explorer'], 'explorer', 3), makeGroup('b', ['editor'], 'editor', 1)])
    expect(weightsOf(normalizeDock(tree, KNOWN) as DockNode)).toEqual([0.75, 0.25])
  })

  it('replaces duplicate and empty group ids', () => {
    const tree = makeSplit('x', [makeGroup('same', ['explorer']), makeGroup('same', ['editor'])])
    const ids = groupEntries(normalizeDock(tree, KNOWN) as DockNode).map((entry) => entry.group.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain('same')
  })

  it('reports nothing left when no known part survives', () => {
    expect(normalizeDock(makeGroup('a', ['gone']), KNOWN)).toBeNull()
    expect(normalizeDock(null, KNOWN)).toBeNull()
  })
})

describe('parsing a stored tree', () => {
  it('refuses anything that is not a tree', () => {
    expect(parseDockNode(null)).toBeNull()
    expect(parseDockNode(42)).toBeNull()
    expect(parseDockNode([])).toBeNull()
    expect(parseDockNode({ kind: 'group', parts: [] })).toBeNull()
    expect(parseDockNode({ kind: 'split', axis: 'z', children: [] })).toBeNull()
    expect(parseDockNode({ kind: 'split', axis: 'x', children: [{ kind: 'group', parts: [] }] })).toBeNull()
  })

  it('round-trips through JSON', () => {
    const tree = sample()
    expect(parseDockNode(JSON.parse(JSON.stringify(tree)))).toEqual(tree)
  })

  it('repairs a weight or an active tab it cannot use', () => {
    const parsed = parseDockNode({ kind: 'group', id: 'a', parts: ['x', 'y'], active: 'nope', weight: -3 })
    expect(parsed).toMatchObject({ active: 'x', weight: 1 })
  })
})
