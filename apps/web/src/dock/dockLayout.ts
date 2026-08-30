import {
  activatePart,
  dockIntoGroup,
  dockToFrame,
  freshGroupId,
  groupEntries,
  isPartOpen,
  largestGroup,
  locatePart,
  makeGroup,
  makeSplit,
  normalizeDock,
  parseDockNode,
  removePart,
  type DockNode
} from './dockModel'
import { ALL_PART_IDS, PARTS, partMeta, type PartId } from './parts'

/** The arrangement as a whole: the tree, plus which group is zoomed.
 *
 *  Zoom is state about the frame rather than about the tree — a zoomed group still
 *  occupies its slot, it is only drawn full-size — so it lives here and the tree
 *  stays a pure description of space.
 *
 *  This module also owns the two policies that decide layout *for* the user:
 *  where the workbench starts, and where a part comes back when it is reopened.
 *  Both are defaults, both are overridable by dragging, and neither is allowed to
 *  lose a part: everything in the catalogue can always be brought back from the
 *  rail. */

export interface DockArrangement {
  readonly root: DockNode | null
  readonly zoomed: string | null
}

/** The workbench as it first appears: what to look at on the left, what you are
 *  working on in the middle, who you are working with on the right. Nothing else
 *  is open, because an empty terminal is not worth a fifth of the window. */
export function defaultDock(): DockArrangement {
  return {
    root: makeSplit('x', [
      makeGroup('left', ['explorer', 'scm', 'run', 'review', 'config'], 'explorer', 0.2),
      makeGroup('center', ['editor'], 'editor', 0.52),
      makeGroup('right', ['chat'], 'chat', 0.28)
    ]),
    zoomed: null
  }
}

/** Drop a zoom that points at a group which no longer exists. */
function settleZoom(arrangement: DockArrangement): DockArrangement {
  const { root, zoomed } = arrangement
  if (!zoomed) return arrangement
  if (!root || !groupEntries(root).some((entry) => entry.group.id === zoomed)) return { root, zoomed: null }
  return arrangement
}

function normalize(arrangement: DockArrangement): DockArrangement {
  return settleZoom({ ...arrangement, root: normalizeDock(arrangement.root, ALL_PART_IDS) })
}

/** Where a part reappears, in order of preference:
 *
 *  1. next to the parts it belongs with — opening 源代码管理 while 资源管理器 is
 *     docked left joins that group instead of carving out a second column;
 *  2. otherwise on its home edge of the frame;
 *  3. and for the editor, which has no edge of its own, as a tab in whichever
 *     group currently has the most room.
 *
 *  Rule 1 is what keeps a dragged-around layout from slowly filling with columns. */
export function openPart(arrangement: DockArrangement, partId: PartId): DockArrangement {
  const { root } = arrangement
  if (!root) return { root: makeGroup(freshGroupId(null), [partId]), zoomed: null }
  if (isPartOpen(root, partId)) return revealPart(arrangement, partId)

  const home = partMeta(partId).home
  const buddy = PARTS.find((part) => part.id !== partId && part.home === home && isPartOpen(root, part.id))
  if (buddy) {
    const host = locatePart(root, buddy.id)
    if (host) return revealPart(normalize({ ...arrangement, root: dockIntoGroup(root, partId, host.group.id) }), partId)
  }
  if (home === 'center') {
    return revealPart(
      normalize({ ...arrangement, root: dockIntoGroup(root, partId, largestGroup(root).group.id) }),
      partId
    )
  }
  return revealPart(normalize({ ...arrangement, root: dockToFrame(root, partId, home) }), partId)
}

/** Bring an already-open part to the front, and un-zoom if it is hiding behind a
 *  zoomed group — a click that appears to do nothing is worse than a moved pane. */
export function revealPart(arrangement: DockArrangement, partId: PartId): DockArrangement {
  const { root, zoomed } = arrangement
  if (!root) return arrangement
  const found = locatePart(root, partId)
  if (!found) return arrangement
  const nextRoot = activatePart(root, partId)
  const nextZoom = zoomed && zoomed !== found.group.id ? null : zoomed
  // Pressing the tab that is already in front is not a layout change, and a new
  // arrangement object here would re-render the workbench on every click.
  if (nextRoot === root && nextZoom === zoomed) return arrangement
  return { root: nextRoot, zoomed: nextZoom }
}

export function closePart(arrangement: DockArrangement, partId: PartId): DockArrangement {
  const { root } = arrangement
  if (!root) return arrangement
  return normalize({ ...arrangement, root: removePart(root, partId) })
}

/** The rail's click: reveal the part, or put it away when it is already the one in
 *  front. The same affordance as an editor's activity bar, generalized to every
 *  part — including the ones that used to be bottom tabs. */
export function togglePart(arrangement: DockArrangement, partId: PartId): DockArrangement {
  const { root, zoomed } = arrangement
  if (!root) return openPart(arrangement, partId)
  const found = locatePart(root, partId)
  const frontmost = found !== null && found.group.active === partId && (!zoomed || zoomed === found.group.id)
  return frontmost ? closePart(arrangement, partId) : openPart(arrangement, partId)
}

export function toggleZoom(arrangement: DockArrangement, groupId: string): DockArrangement {
  return settleZoom({ ...arrangement, zoomed: arrangement.zoomed === groupId ? null : groupId })
}

/** Apply a tree edit from a drag or a sash, keeping the invariants in one place. */
export function withRoot(arrangement: DockArrangement, root: DockNode | null): DockArrangement {
  return normalize({ ...arrangement, root })
}

// ---------------------------------------------------------------- persistence

export const DOCK_STORAGE_KEY = 'botcf.dock.v1'
/** The fixed-slot layout this dock replaced. Read once, then never again. */
export const LEGACY_WORKBENCH_KEY = 'botcf.workbench.v1'

export function serializeDock(arrangement: DockArrangement): string {
  return JSON.stringify({ version: 1, root: arrangement.root, zoomed: arrangement.zoomed })
}

export function parseStoredDock(raw: string | null): DockArrangement | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as { root?: unknown; zoomed?: unknown }
  const root = normalizeDock(parseDockNode(record.root), ALL_PART_IDS)
  if (!root) return null
  const zoomed = typeof record.zoomed === 'string' ? record.zoomed : null
  return settleZoom({ root, zoomed })
}

/** Nominal frame the legacy pixel sizes were measured against. Only the ratios
 *  survive the migration, which is the point: they restore at any window size. */
const NOMINAL_WIDTH = 1388
const NOMINAL_HEIGHT = 796

function share(pixels: unknown, nominal: number, fallback: number): number {
  if (typeof pixels !== 'number' || !Number.isFinite(pixels) || pixels <= 0) return fallback
  return Math.min(0.6, Math.max(0.12, pixels / nominal))
}

/** Rebuild the old fixed-slot arrangement as a dock tree, so an upgrade does not
 *  rearrange someone's workbench underneath them. The five sidebar views become
 *  five tabs of one group — which is what they always were, behind an activity bar
 *  that only let one of them be visible. */
export function migrateWorkbench(raw: string | null): DockArrangement | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const state = parsed as Record<string, unknown>
  const views: PartId[] = ['explorer', 'scm', 'run', 'review', 'config']
  const panels: PartId[] = ['problems', 'terminal', 'preview']
  const view = views.find((id) => id === state.view) ?? 'explorer'
  const panel = panels.find((id) => id === state.panel) ?? 'problems'

  const leftShare = share(state.sidebarWidth, NOMINAL_WIDTH, 0.2)
  const rightShare = share(state.chatWidth, NOMINAL_WIDTH, 0.28)
  const panelShare = share(state.panelHeight, NOMINAL_HEIGHT, 0.3)
  const withSidebar = state.sidebarVisible !== false
  const withChat = state.chatVisible !== false
  const withPanel = state.panelVisible === true

  const centre: DockNode = withPanel
    ? makeSplit(
        'y',
        [makeGroup('center', ['editor'], 'editor', 1 - panelShare), makeGroup('bottom', panels, panel, panelShare)],
        1 - (withSidebar ? leftShare : 0) - (withChat ? rightShare : 0)
      )
    : makeGroup('center', ['editor'], 'editor', 1 - (withSidebar ? leftShare : 0) - (withChat ? rightShare : 0))

  const columns: DockNode[] = [
    ...(withSidebar ? [makeGroup('left', views, view, leftShare)] : []),
    centre,
    ...(withChat ? [makeGroup('right', ['chat'], 'chat', rightShare)] : [])
  ]
  const zoomed = withPanel && state.panelMaximized === true ? 'bottom' : null
  return normalize({ root: columns.length === 1 ? columns[0] : makeSplit('x', columns), zoomed })
}

/** What the workbench opens with: a stored dock, else a migrated legacy layout,
 *  else the default. Storage being unavailable is not an error worth surfacing —
 *  the layout simply does not persist for that session. */
export function loadDock(): DockArrangement {
  try {
    const stored = parseStoredDock(localStorage.getItem(DOCK_STORAGE_KEY))
    if (stored) return stored
    const migrated = migrateWorkbench(localStorage.getItem(LEGACY_WORKBENCH_KEY))
    if (migrated?.root) return migrated
  } catch {
    /* private mode, or a hostile extension — fall through to the default */
  }
  return defaultDock()
}
