/** Pure model behind the 2D resizable panel grid.
 *
 *  Layout is column-major: `columns` runs left→right, and each column stacks its
 *  `rows` top→bottom. Weights are proportional (flex-grow), never pixels, so a
 *  stored layout restores correctly at any window size. Every operation returns
 *  a new layout — nothing here mutates its input. */

export interface GridRow {
  id: string
  weight: number
}

export interface GridColumn {
  weight: number
  rows: GridRow[]
}

export interface GridLayout {
  columns: GridColumn[]
}

export type DropZone = 'left' | 'right' | 'top' | 'bottom'

export interface PanelPosition {
  column: number
  row: number
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

const MIN_WEIGHT = 0.05

export function emptyLayout(): GridLayout {
  return { columns: [] }
}

function positiveWeight(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Legacy single-row layout (`{order, weights}`) — one panel per column. */
function fromLegacy(order: readonly string[], weights: Record<string, unknown>): GridLayout {
  return {
    columns: order
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .map((id) => ({ weight: positiveWeight(weights[id]), rows: [{ id, weight: 1 }] }))
  }
}

/** Validate a stored layout, accepting the legacy shape. Never throws: a corrupt
 *  entry degrades to an empty layout, which normalizes to the default arrangement. */
export function parseStoredLayout(raw: string | null): GridLayout {
  if (!raw) return emptyLayout()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyLayout()
  }
  if (!parsed || typeof parsed !== 'object') return emptyLayout()
  const record = parsed as { columns?: unknown; order?: unknown; weights?: unknown }
  if (Array.isArray(record.order)) {
    const weights = record.weights && typeof record.weights === 'object' ? (record.weights as Record<string, unknown>) : {}
    return fromLegacy(record.order as string[], weights)
  }
  if (!Array.isArray(record.columns)) return emptyLayout()
  const columns: GridColumn[] = []
  for (const rawColumn of record.columns) {
    if (!rawColumn || typeof rawColumn !== 'object') continue
    const { weight, rows } = rawColumn as { weight?: unknown; rows?: unknown }
    if (!Array.isArray(rows)) continue
    const parsedRows: GridRow[] = []
    for (const rawRow of rows) {
      if (!rawRow || typeof rawRow !== 'object') continue
      const { id, weight: rowWeight } = rawRow as { id?: unknown; weight?: unknown }
      if (typeof id !== 'string' || id === '') continue
      parsedRows.push({ id, weight: positiveWeight(rowWeight) })
    }
    if (parsedRows.length > 0) columns.push({ weight: positiveWeight(weight), rows: parsedRows })
  }
  return { columns }
}

export function serializeLayout(layout: GridLayout): string {
  return JSON.stringify(layout)
}

function dropEmpty(columns: readonly GridColumn[]): GridColumn[] {
  return columns.filter((column) => column.rows.length > 0)
}

/** Reconcile a stored layout with the panels that actually exist: unknown ids are
 *  dropped, duplicates collapse to their first position, and panels never seen
 *  before are appended as new columns on the right in `ids` order, using
 *  `defaultWeights` for their initial share. */
export function normalizeLayout(
  layout: GridLayout,
  ids: readonly string[],
  defaultWeights: Readonly<Record<string, number>> = {}
): GridLayout {
  const known = new Set(ids)
  const seen = new Set<string>()
  const columns = dropEmpty(
    layout.columns.map((column) => ({
      weight: positiveWeight(column.weight),
      rows: column.rows.filter((row) => {
        if (!known.has(row.id) || seen.has(row.id)) return false
        seen.add(row.id)
        return true
      })
    }))
  )
  const appended = ids
    .filter((id) => !seen.has(id))
    .map((id) => ({ weight: positiveWeight(defaultWeights[id]), rows: [{ id, weight: 1 }] }))
  return { columns: [...columns, ...appended] }
}

export function findPanel(layout: GridLayout, id: string): PanelPosition | null {
  for (let column = 0; column < layout.columns.length; column++) {
    const row = layout.columns[column].rows.findIndex((entry) => entry.id === id)
    if (row >= 0) return { column, row }
  }
  return null
}

export function panelIds(layout: GridLayout): string[] {
  return layout.columns.flatMap((column) => column.rows.map((row) => row.id))
}

/** Move `delta` weight from the second item of a pair to the first, honouring
 *  both minimums. Returns the pair unchanged when the minimums leave no room. */
export function adjustPair(a: number, b: number, delta: number, minA: number, minB: number): [number, number] {
  const total = a + b
  const floorA = Math.max(MIN_WEIGHT, Math.min(minA, total / 2))
  const floorB = Math.max(MIN_WEIGHT, Math.min(minB, total / 2))
  if (floorA + floorB >= total) return [a, b]
  const nextA = Math.min(Math.max(a + delta, floorA), total - floorB)
  return [nextA, total - nextA]
}

/** Drag a vertical gutter: resize columns `index` and `index + 1`. */
export function resizeColumns(
  layout: GridLayout,
  index: number,
  delta: number,
  minLeft = MIN_WEIGHT,
  minRight = MIN_WEIGHT
): GridLayout {
  const left = layout.columns[index]
  const right = layout.columns[index + 1]
  if (!left || !right) return layout
  const [nextLeft, nextRight] = adjustPair(left.weight, right.weight, delta, minLeft, minRight)
  const columns = [...layout.columns]
  columns[index] = { ...left, weight: nextLeft }
  columns[index + 1] = { ...right, weight: nextRight }
  return { columns }
}

/** Drag a horizontal gutter: resize rows `index` and `index + 1` of one column. */
export function resizeRows(
  layout: GridLayout,
  columnIndex: number,
  index: number,
  delta: number,
  minTop = MIN_WEIGHT,
  minBottom = MIN_WEIGHT
): GridLayout {
  const column = layout.columns[columnIndex]
  if (!column) return layout
  const top = column.rows[index]
  const bottom = column.rows[index + 1]
  if (!top || !bottom) return layout
  const [nextTop, nextBottom] = adjustPair(top.weight, bottom.weight, delta, minTop, minBottom)
  const rows = [...column.rows]
  rows[index] = { ...top, weight: nextTop }
  rows[index + 1] = { ...bottom, weight: nextBottom }
  const columns = [...layout.columns]
  columns[columnIndex] = { ...column, rows }
  return { columns }
}

function removePanel(layout: GridLayout, id: string): { layout: GridLayout; weight: number } {
  const position = findPanel(layout, id)
  if (!position) return { layout, weight: 1 }
  const column = layout.columns[position.column]
  const weight = column.rows[position.row].weight
  const columns = [...layout.columns]
  columns[position.column] = { ...column, rows: column.rows.filter((_, index) => index !== position.row) }
  return { layout: { columns: dropEmpty(columns) }, weight }
}

/**
 * Drop `id` onto `targetId`: left/right splits the target's column horizontally
 * (a new column beside it), top/bottom stacks inside the target's column. The
 * space for the moved panel is taken from the target, so the rest of the grid
 * keeps its proportions.
 */
export function movePanel(layout: GridLayout, id: string, targetId: string, zone: DropZone): GridLayout {
  if (id === targetId) return layout
  if (!findPanel(layout, id) || !findPanel(layout, targetId)) return layout
  const { layout: without } = removePanel(layout, id)
  const target = findPanel(without, targetId)
  if (!target) return layout
  const column = without.columns[target.column]

  if (zone === 'top' || zone === 'bottom') {
    const targetRow = column.rows[target.row]
    const share = targetRow.weight / 2
    const rows = [...column.rows]
    rows[target.row] = { ...targetRow, weight: share }
    rows.splice(zone === 'top' ? target.row : target.row + 1, 0, { id, weight: share })
    const columns = [...without.columns]
    columns[target.column] = { ...column, rows }
    return { columns }
  }

  const share = column.weight / 2
  const columns = [...without.columns]
  columns[target.column] = { ...column, weight: share }
  columns.splice(zone === 'left' ? target.column : target.column + 1, 0, {
    weight: share,
    rows: [{ id, weight: 1 }]
  })
  return { columns }
}

/** Which quadrant of a panel a pointer sits in, split along the diagonals.
 *  Ties resolve horizontally, which matches the previous left/right-only feel. */
export function dropZoneFor(x: number, y: number, rect: Rect): DropZone {
  const width = rect.width > 0 ? rect.width : 1
  const height = rect.height > 0 ? rect.height : 1
  const fromLeft = (x - rect.left) / width
  const fromTop = (y - rect.top) / height
  const distances: Array<[DropZone, number]> = [
    ['left', fromLeft],
    ['right', 1 - fromLeft],
    ['top', fromTop],
    ['bottom', 1 - fromTop]
  ]
  return distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))[0]
}

/** Even split of a container's weights, for the gutter double-click reset. */
export function evenLayout(layout: GridLayout): GridLayout {
  return {
    columns: layout.columns.map((column) => ({
      weight: 1,
      rows: column.rows.map((row) => ({ ...row, weight: 1 }))
    }))
  }
}
