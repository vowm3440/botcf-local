/** The dock tree — the one layout primitive the whole workbench is built from.
 *
 *  A node is either a *group* (a stack of parts behind one tab strip) or a
 *  *split* (children laid out along one axis, each with a share of the space).
 *  That is the entire vocabulary. A sidebar is a group; the bottom panel is a
 *  group; the editor is a group. There is no separate kind of container for any of
 *  them, which is why every one of them resizes, docks, tabs, zooms and closes the
 *  same way, and why adding a feature never touches this file.
 *
 *  Two rules make the rest of the code simple:
 *
 *  1. **Shares, not pixels.** A child's `weight` is its fraction of the parent, and
 *     siblings always sum to 1 (`normalizeDock` guarantees it). A layout therefore
 *     restores correctly at any window size, and a group's area is simply the
 *     product of the weights down to it — which is how "reopen in the biggest
 *     group" can be answered without measuring the DOM.
 *  2. **Nothing here mutates.** Every operation returns a new tree, so the React
 *     binding is a `useState` away and undo would be a stack of these values.
 *
 *  Pixel minimums are deliberately *not* stored here: they belong to the parts, and
 *  the sash converts them to weight at drag time using the container it measured. */

export type DockAxis = 'x' | 'y'
export type DockEdge = 'left' | 'right' | 'top' | 'bottom'
/** Where a dragged part lands relative to a group: a tab in it, or beside it. */
export type DockZone = DockEdge | 'center'

export interface DockGroupNode {
  readonly kind: 'group'
  readonly id: string
  /** Share of the parent split. Meaningless on the root. */
  readonly weight: number
  readonly parts: readonly string[]
  readonly active: string
}

export interface DockSplitNode {
  readonly kind: 'split'
  readonly axis: DockAxis
  readonly weight: number
  readonly children: readonly DockNode[]
}

export type DockNode = DockGroupNode | DockSplitNode
/** Child indexes from the root down to a node. */
export type DockPath = readonly number[]

export interface PartLocation {
  readonly group: DockGroupNode
  readonly path: DockPath
  readonly index: number
}

export interface GroupEntry {
  readonly group: DockGroupNode
  readonly path: DockPath
  /** Fraction of the frame this group occupies, 0–1. */
  readonly area: number
}

/** No pane may be squeezed below this share, whatever the pixel minimums say —
 *  a pane at 0 is a pane the user cannot find again. */
const MIN_WEIGHT = 0.04
/** What a part docked to a frame edge takes from everything already there. Shared
 *  with the drop indicator, so the highlight is the size of the actual outcome. */
export const FRAME_SHARE = 0.24

export function axisOfEdge(edge: DockEdge): DockAxis {
  return edge === 'left' || edge === 'right' ? 'x' : 'y'
}

/** True when the edge puts the newcomer *before* its neighbour in the children. */
export function isLeadingEdge(edge: DockEdge): boolean {
  return edge === 'left' || edge === 'top'
}

function positiveWeight(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function makeGroup(
  id: string,
  parts: readonly string[],
  active: string = parts[0],
  weight = 1
): DockGroupNode {
  return { kind: 'group', id, weight, parts, active: parts.includes(active) ? active : parts[0] }
}

export function makeSplit(axis: DockAxis, children: readonly DockNode[], weight = 1): DockSplitNode {
  return { kind: 'split', axis, weight, children }
}

// ---------------------------------------------------------------- reading

export function nodeAt(root: DockNode, path: DockPath): DockNode | null {
  let node: DockNode = root
  for (const index of path) {
    if (node.kind !== 'split') return null
    const child = node.children[index]
    if (!child) return null
    node = child
  }
  return node
}

/** Every group, in document order, with its path and its share of the frame. */
export function groupEntries(root: DockNode): readonly GroupEntry[] {
  const out: GroupEntry[] = []
  const walk = (node: DockNode, path: readonly number[], area: number): void => {
    if (node.kind === 'group') {
      out.push({ group: node, path, area })
      return
    }
    node.children.forEach((child, index) => walk(child, [...path, index], area * child.weight))
  }
  walk(root, [], 1)
  return out
}

export function findGroup(root: DockNode, groupId: string): GroupEntry | null {
  return groupEntries(root).find((entry) => entry.group.id === groupId) ?? null
}

export function locatePart(root: DockNode, partId: string): PartLocation | null {
  for (const { group, path } of groupEntries(root)) {
    const index = group.parts.indexOf(partId)
    if (index >= 0) return { group, path, index }
  }
  return null
}

export function openParts(root: DockNode | null): readonly string[] {
  if (!root) return []
  return groupEntries(root).flatMap((entry) => entry.group.parts)
}

export function isPartOpen(root: DockNode | null, partId: string): boolean {
  return root !== null && locatePart(root, partId) !== null
}

/** The largest group by area — where a part with no edge of its own reappears. */
export function largestGroup(root: DockNode): GroupEntry {
  return groupEntries(root).reduce((best, entry) => (entry.area > best.area ? entry : best))
}

/** A group's own id generator: deterministic, so tests and stored layouts agree. */
export function freshGroupId(root: DockNode | null): string {
  let max = 0
  if (root) {
    for (const { group } of groupEntries(root)) {
      const match = /^g(\d+)$/.exec(group.id)
      if (match) max = Math.max(max, Number(match[1]))
    }
  }
  return `g${max + 1}`
}

// ---------------------------------------------------------------- writing

/** A split that lost children collapses: one child replaces it (inheriting its
 *  share), no children removes it from its own parent. Without this, closing parts
 *  would leave a tree of empty containers holding space. */
function withChildren(split: DockSplitNode, children: readonly DockNode[]): DockNode | null {
  if (children.length === 0) return null
  if (children.length === 1) return { ...children[0], weight: split.weight }
  return { ...split, children }
}

/** Replace (or, with `null`, remove) the node at `path`, collapsing on the way up. */
export function replaceAt(root: DockNode, path: DockPath, next: DockNode | null): DockNode | null {
  if (path.length === 0) return next
  if (root.kind !== 'split') return root
  const [index, ...rest] = path
  const child = root.children[index]
  if (!child) return root
  const replaced = replaceAt(child, rest, next)
  const children =
    replaced === null
      ? root.children.filter((_, at) => at !== index)
      : root.children.map((entry, at) => (at === index ? replaced : entry))
  return withChildren(root, children)
}

/** Closing a tab selects its right-hand neighbour, or its left one if it was last
 *  — the same choice editors and browsers make. */
function neighbourOf(parts: readonly string[], removed: string): string {
  const index = parts.indexOf(removed)
  const rest = parts.filter((part) => part !== removed)
  return rest[Math.min(index, rest.length - 1)]
}

/** Remove a part. Returns `null` when it was the last part in the whole frame,
 *  which the caller renders as the empty workbench rather than as a failure. */
export function removePart(root: DockNode, partId: string): DockNode | null {
  const found = locatePart(root, partId)
  if (!found) return root
  const { group, path } = found
  const parts = group.parts.filter((part) => part !== partId)
  if (parts.length === 0) return replaceAt(root, path, null)
  const active = group.active === partId ? neighbourOf(group.parts, partId) : group.active
  return replaceAt(root, path, { ...group, parts, active })
}

export function activatePart(root: DockNode, partId: string): DockNode {
  const found = locatePart(root, partId)
  if (!found || found.group.active === partId) return root
  return replaceAt(root, found.path, { ...found.group, active: partId }) ?? root
}

/** Insert `parts` order: before `before`, or at the end when it is null. */
function insertBefore(parts: readonly string[], partId: string, before: string | null): string[] {
  const rest = parts.filter((part) => part !== partId)
  const at = before === null ? rest.length : rest.indexOf(before)
  if (at < 0) return [...rest, partId]
  return [...rest.slice(0, at), partId, ...rest.slice(at)]
}

/** Reorder a tab inside its own group. */
export function reorderPart(root: DockNode, groupId: string, partId: string, before: string | null): DockNode {
  const entry = findGroup(root, groupId)
  if (!entry || !entry.group.parts.includes(partId) || before === partId) return root
  const parts = insertBefore(entry.group.parts, partId, before)
  return replaceAt(root, entry.path, { ...entry.group, parts, active: partId }) ?? root
}

/** Drop a part *into* a group: it becomes a tab there and takes focus. Works for a
 *  part that is not open yet, which is how the rail reopens one. */
export function dockIntoGroup(
  root: DockNode,
  partId: string,
  groupId: string,
  before: string | null = null
): DockNode {
  const target = findGroup(root, groupId)
  if (!target) return root
  if (target.group.parts.includes(partId)) {
    return before === null ? activatePart(root, partId) : reorderPart(root, groupId, partId, before)
  }
  const without = removePart(root, partId) ?? root
  const entry = findGroup(without, groupId)
  if (!entry) return root
  const parts = insertBefore(entry.group.parts, partId, before)
  return replaceAt(without, entry.path, { ...entry.group, parts, active: partId }) ?? root
}

/** Split the target's slot and put the part in the new half. The space comes from
 *  the target alone, so the rest of the layout keeps its proportions. */
function insertBeside(root: DockNode, path: DockPath, node: DockNode, edge: DockEdge): DockNode {
  const target = nodeAt(root, path)
  if (!target) return root
  const half = target.weight / 2
  const pair: readonly DockNode[] = isLeadingEdge(edge)
    ? [{ ...node, weight: half }, { ...target, weight: half }]
    : [{ ...target, weight: half }, { ...node, weight: half }]
  const wrapped = makeSplit(axisOfEdge(edge), pair, target.weight)
  return replaceAt(root, path, wrapped) ?? wrapped
}

/** Drop a part on one edge of a group: a new group appears beside it. */
export function dockBesideGroup(root: DockNode, partId: string, groupId: string, edge: DockEdge): DockNode {
  const target = findGroup(root, groupId)
  if (!target) return root
  // A lone part cannot be docked next to itself; the gesture is a no-op, not a
  // tree that splits into an empty half.
  if (target.group.parts.length === 1 && target.group.parts[0] === partId) return root
  const without = removePart(root, partId) ?? root
  const entry = findGroup(without, groupId)
  if (!entry) return root
  return insertBeside(without, entry.path, makeGroup(freshGroupId(without), [partId]), edge)
}

/** Dock a part to an edge of the whole frame. Docking to an edge the frame is
 *  already split along extends that split instead of nesting another one — the
 *  reason a layout stays two levels deep no matter how much it is rearranged. */
export function dockToFrame(root: DockNode | null, partId: string, edge: DockEdge): DockNode {
  const without = root ? removePart(root, partId) : null
  const group = makeGroup(freshGroupId(without), [partId], partId, FRAME_SHARE)
  if (!without) return { ...group, weight: 1 }
  const axis = axisOfEdge(edge)
  if (without.kind === 'split' && without.axis === axis) {
    const scaled = without.children.map((child) => ({ ...child, weight: child.weight * (1 - FRAME_SHARE) }))
    const children = isLeadingEdge(edge) ? [group, ...scaled] : [...scaled, group]
    return { ...without, children }
  }
  const kept: DockNode = { ...without, weight: 1 - FRAME_SHARE }
  const children = isLeadingEdge(edge) ? [group, kept] : [kept, group]
  return makeSplit(axis, children, without.weight)
}

/** Move `delta` share from the trailing sibling to the leading one, honouring both
 *  minimums. Returns the pair unchanged when the minimums leave no room. */
export function adjustPair(a: number, b: number, delta: number, minA: number, minB: number): [number, number] {
  const total = a + b
  const floorA = Math.max(MIN_WEIGHT, Math.min(minA, total / 2))
  const floorB = Math.max(MIN_WEIGHT, Math.min(minB, total / 2))
  if (floorA + floorB >= total) return [a, b]
  const nextA = Math.min(Math.max(a + delta, floorA), total - floorB)
  return [nextA, total - nextA]
}

/** Drag the sash between children `index` and `index + 1` of the split at `path`.
 *  Minimums arrive already converted from pixels to share by the caller, which is
 *  the only place that knows how big the container actually is. */
export function resizeSplit(
  root: DockNode,
  path: DockPath,
  index: number,
  delta: number,
  minLeading = MIN_WEIGHT,
  minTrailing = MIN_WEIGHT
): DockNode {
  const split = nodeAt(root, path)
  if (!split || split.kind !== 'split') return root
  const leading = split.children[index]
  const trailing = split.children[index + 1]
  if (!leading || !trailing) return root
  const [a, b] = adjustPair(leading.weight, trailing.weight, delta, minLeading, minTrailing)
  const children = split.children.map((child, at) =>
    at === index ? { ...child, weight: a } : at === index + 1 ? { ...child, weight: b } : child
  )
  return replaceAt(root, path, { ...split, children }) ?? root
}

/** Even out one split — the double-click on a sash. */
export function evenSplit(root: DockNode, path: DockPath): DockNode {
  const split = nodeAt(root, path)
  if (!split || split.kind !== 'split') return root
  const share = 1 / split.children.length
  const children = split.children.map((child) => ({ ...child, weight: share }))
  return replaceAt(root, path, { ...split, children }) ?? root
}

/** Smallest pixel extent a subtree can hold along one axis: mins add up along that
 *  axis and compete across the other one. */
export function minExtent(node: DockNode, axis: DockAxis, minOfPart: (partId: string) => number): number {
  if (node.kind === 'group') return Math.max(0, ...node.parts.map(minOfPart))
  const extents = node.children.map((child) => minExtent(child, axis, minOfPart))
  return node.axis === axis ? extents.reduce((sum, value) => sum + value, 0) : Math.max(0, ...extents)
}

// ---------------------------------------------------------------- normalizing

function rescale(children: readonly DockNode[], total = 1): readonly DockNode[] {
  const sum = children.reduce((value, child) => value + child.weight, 0)
  if (!(sum > 0)) {
    const share = total / children.length
    return children.map((child) => ({ ...child, weight: share }))
  }
  return children.map((child) => ({ ...child, weight: (child.weight / sum) * total }))
}

interface NormalizeContext {
  known: ReadonlySet<string>
  seen: Set<string>
  ids: Set<string>
  next: number
}

function uniqueId(context: NormalizeContext): string {
  let id = `g${context.next++}`
  while (context.ids.has(id)) id = `g${context.next++}`
  return id
}

function normalizeNode(node: DockNode, context: NormalizeContext): DockNode | null {
  if (node.kind === 'group') {
    const parts = node.parts.filter((part) => context.known.has(part) && !context.seen.has(part))
    for (const part of parts) context.seen.add(part)
    if (parts.length === 0) return null
    const id = node.id !== '' && !context.ids.has(node.id) ? node.id : uniqueId(context)
    context.ids.add(id)
    return makeGroup(id, parts, node.active, positiveWeight(node.weight))
  }
  const children = node.children
    .map((child) => normalizeNode(child, context))
    .filter((child): child is DockNode => child !== null)
  // Fold a same-axis child into this split: two sashes in a row that do the same
  // thing are two ways to say one thing.
  const flat = children.flatMap((child) =>
    child.kind === 'split' && child.axis === node.axis ? rescale(child.children, child.weight) : [child]
  )
  if (flat.length === 0) return null
  if (flat.length === 1) return { ...flat[0], weight: positiveWeight(node.weight) }
  return makeSplit(node.axis, rescale(flat), positiveWeight(node.weight))
}

/** Reconcile a tree with the parts that actually exist: unknown ids are dropped, a
 *  part that somehow appears twice keeps its first home, empty groups and
 *  single-child splits collapse, group ids are made unique and sibling shares are
 *  rescaled to sum to 1. `null` means nothing is left to show. */
export function normalizeDock(root: DockNode | null, known: readonly string[]): DockNode | null {
  if (!root) return null
  let highest = 0
  for (const { group } of groupEntries(root)) {
    const match = /^g(\d+)$/.exec(group.id)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  const normalized = normalizeNode(root, {
    known: new Set(known),
    seen: new Set(),
    ids: new Set(),
    next: highest + 1
  })
  return normalized ? { ...normalized, weight: 1 } : null
}

/** Validate a decoded layout. Never throws: an entry written by an older build, or
 *  by something that is not this app at all, degrades to `null` and the caller
 *  falls back to the default arrangement. Duplicates and unknown parts are left
 *  for `normalizeDock`, which is the one place that knows what exists. */
export function parseDockNode(raw: unknown): DockNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const weight = positiveWeight(record.weight)
  if (record.kind === 'group') {
    const parts = Array.isArray(record.parts)
      ? record.parts.filter((part): part is string => typeof part === 'string' && part !== '')
      : []
    if (parts.length === 0) return null
    const id = typeof record.id === 'string' && record.id !== '' ? record.id : ''
    const active = typeof record.active === 'string' ? record.active : parts[0]
    return makeGroup(id, parts, active, weight)
  }
  if (record.kind === 'split') {
    const axis = record.axis === 'x' || record.axis === 'y' ? record.axis : null
    if (!axis || !Array.isArray(record.children)) return null
    const children = record.children
      .map((child) => parseDockNode(child))
      .filter((child): child is DockNode => child !== null)
    if (children.length === 0) return null
    return makeSplit(axis, children, weight)
  }
  return null
}
