import { describe, expect, it } from 'vitest'
import {
  closePart,
  defaultDock,
  loadDock,
  migrateWorkbench,
  openPart,
  parseStoredDock,
  revealPart,
  serializeDock,
  toggleZoom,
  togglePart
} from '../src/dock/dockLayout'
import { findGroup, groupEntries, locatePart, openParts, type DockNode } from '../src/dock/dockModel'
import { ALL_PART_IDS } from '../src/dock/parts'

/** The policies that place panes *for* the user — where the workbench starts, and
 *  where a part comes back when it is reopened. Both are the kind of rule that is
 *  obvious until it is written down, and then turns out to have four cases. */

function groupIds(root: DockNode | null): string[] {
  return root ? groupEntries(root).map((entry) => entry.group.id) : []
}

function weights(root: DockNode | null): number[] {
  return root && root.kind === 'split' ? root.children.map((child) => child.weight) : []
}

describe('the default arrangement', () => {
  it('opens what you look at, what you work on, and who you work with', () => {
    const { root, zoomed } = defaultDock()
    expect(groupIds(root)).toEqual(['left', 'center', 'right'])
    expect(openParts(root)).toEqual(['explorer', 'scm', 'run', 'review', 'config', 'editor', 'chat'])
    expect(zoomed).toBeNull()
  })

  it('leaves the output panes closed rather than spending the window on empty ones', () => {
    const open = new Set(openParts(defaultDock().root))
    expect(open.has('terminal')).toBe(false)
    expect(open.has('problems')).toBe(false)
    expect(open.has('preview')).toBe(false)
  })

  it('shares out the whole frame', () => {
    expect(weights(defaultDock().root).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1)
  })

  it('describes every part in the catalogue', () => {
    expect(ALL_PART_IDS).toHaveLength(10)
  })
})

describe('reopening a part', () => {
  it('sends the first output pane to the bottom of the frame', () => {
    const opened = openPart(defaultDock(), 'terminal')
    expect(opened.root).toMatchObject({ kind: 'split', axis: 'y' })
    const entry = locatePart(opened.root as DockNode, 'terminal')
    expect(entry?.group.parts).toEqual(['terminal'])
    expect(entry?.group.active).toBe('terminal')
    // The row it created spans the frame, under everything else.
    expect(weights(opened.root)).toHaveLength(2)
    expect(weights(opened.root)[1]).toBeCloseTo(0.24)
  })

  it('joins parts that share a home instead of carving out another pane', () => {
    const withTerminal = openPart(defaultDock(), 'terminal')
    const withBoth = openPart(withTerminal, 'problems')
    expect(groupIds(withBoth.root)).toEqual(groupIds(withTerminal.root))
    const entry = locatePart(withBoth.root as DockNode, 'problems')
    expect(entry?.group.parts).toEqual(['terminal', 'problems'])
    expect(entry?.group.active).toBe('problems')
  })

  it('puts a part with no edge of its own in the pane with the most room', () => {
    const closed = closePart(defaultDock(), 'editor')
    expect(groupIds(closed.root)).toEqual(['left', 'right'])
    // With the middle gone the assistant column is the largest, so that is where
    // the editor comes back — as a tab, not as a third column.
    const reopened = openPart(closed, 'editor')
    expect(groupIds(reopened.root)).toEqual(['left', 'right'])
    expect(locatePart(reopened.root as DockNode, 'editor')?.group.id).toBe('right')
  })

  it('brings an already-open part forward without moving it', () => {
    const before = defaultDock()
    const after = openPart(before, 'scm')
    expect(groupIds(after.root)).toEqual(groupIds(before.root))
    expect(findGroup(after.root as DockNode, 'left')?.group.active).toBe('scm')
  })

  it('makes the first part of an empty frame the whole frame', () => {
    const empty = { root: null, zoomed: null }
    expect(openPart(empty, 'editor').root).toMatchObject({ kind: 'group', parts: ['editor'] })
  })

  it('un-zooms whatever was hiding the part', () => {
    const zoomed = toggleZoom(defaultDock(), 'left')
    expect(openPart(zoomed, 'chat').zoomed).toBeNull()
    // Revealing something inside the zoomed group keeps the zoom.
    expect(revealPart(zoomed, 'scm').zoomed).toBe('left')
  })
})

describe('the rail toggle', () => {
  it('puts away the part that is in front, and brings back the one that is not', () => {
    const closed = togglePart(defaultDock(), 'explorer')
    expect(openParts(closed.root)).not.toContain('explorer')
    expect(findGroup(closed.root as DockNode, 'left')?.group.active).toBe('scm')
    const reopened = togglePart(closed, 'explorer')
    expect(locatePart(reopened.root as DockNode, 'explorer')?.group.id).toBe('left')
  })

  it('brings a backgrounded tab forward rather than closing it', () => {
    const behind = defaultDock()
    const front = togglePart(behind, 'scm')
    expect(findGroup(front.root as DockNode, 'left')?.group.active).toBe('scm')
    expect(openParts(front.root)).toContain('scm')
  })
})

describe('closing parts', () => {
  it('collapses the pane it emptied and shares the space out again', () => {
    const closed = closePart(defaultDock(), 'chat')
    expect(groupIds(closed.root)).toEqual(['left', 'center'])
    expect(weights(closed.root).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1)
  })

  it('drops a zoom whose group no longer exists', () => {
    const zoomed = toggleZoom(defaultDock(), 'right')
    expect(zoomed.zoomed).toBe('right')
    expect(closePart(zoomed, 'chat').zoomed).toBeNull()
    // Closing something else leaves the zoom alone.
    expect(closePart(zoomed, 'explorer').zoomed).toBe('right')
  })

  it('can be taken all the way down to an empty frame', () => {
    const empty = openParts(defaultDock().root).reduce(
      (arrangement, part) => closePart(arrangement, part as 'editor'),
      defaultDock()
    )
    expect(empty.root).toBeNull()
  })
})

describe('persistence', () => {
  it('round-trips an arrangement', () => {
    const arrangement = toggleZoom(openPart(defaultDock(), 'terminal'), 'left')
    expect(parseStoredDock(serializeDock(arrangement))).toEqual(arrangement)
  })

  it('treats anything unreadable as no stored layout at all', () => {
    expect(parseStoredDock(null)).toBeNull()
    expect(parseStoredDock('not json')).toBeNull()
    expect(parseStoredDock('[]')).toBeNull()
    expect(parseStoredDock('{"root":{"kind":"group","parts":["gone"]}}')).toBeNull()
  })

  it('discards a zoom that points at nothing', () => {
    const stored = serializeDock({ ...defaultDock(), zoomed: 'no-such-group' })
    expect(parseStoredDock(stored)?.zoomed).toBeNull()
  })

  it('falls back to the default when storage is unavailable', () => {
    // No localStorage in this environment, which is the same situation as a browser
    // in private mode: the layout applies, it just does not persist.
    expect(loadDock()).toEqual(defaultDock())
  })
})

describe('migrating the fixed-slot layout', () => {
  it('rebuilds the three columns, with the sidebar views as tabs of one pane', () => {
    const migrated = migrateWorkbench(
      JSON.stringify({
        view: 'scm',
        sidebarVisible: true,
        sidebarWidth: 260,
        panel: 'terminal',
        panelVisible: false,
        chatVisible: true,
        chatWidth: 420
      })
    )
    expect(groupIds(migrated?.root ?? null)).toEqual(['left', 'center', 'right'])
    expect(findGroup(migrated?.root as DockNode, 'left')?.group).toMatchObject({
      parts: ['explorer', 'scm', 'run', 'review', 'config'],
      active: 'scm'
    })
    expect(openParts(migrated?.root ?? null)).not.toContain('terminal')
  })

  it('keeps the proportions the user had set', () => {
    const migrated = migrateWorkbench(
      JSON.stringify({ sidebarVisible: true, sidebarWidth: 600, chatVisible: true, chatWidth: 300 })
    )
    const [left, , right] = weights(migrated?.root ?? null)
    expect(left).toBeGreaterThan(right)
  })

  it('omits the panes that were hidden', () => {
    const migrated = migrateWorkbench(JSON.stringify({ sidebarVisible: false, chatVisible: false }))
    expect(migrated?.root).toMatchObject({ kind: 'group', parts: ['editor'], weight: 1 })
  })

  it('restores an open bottom panel, and its maximized state as a zoom', () => {
    const migrated = migrateWorkbench(
      JSON.stringify({
        sidebarVisible: true,
        chatVisible: true,
        panelVisible: true,
        panel: 'preview',
        panelHeight: 240,
        panelMaximized: true
      })
    )
    const entry = locatePart(migrated?.root as DockNode, 'preview')
    expect(entry?.group.parts).toEqual(['problems', 'terminal', 'preview'])
    expect(entry?.group.active).toBe('preview')
    expect(migrated?.zoomed).toBe('bottom')
  })

  it('ignores an entry it cannot read', () => {
    expect(migrateWorkbench(null)).toBeNull()
    expect(migrateWorkbench('not json')).toBeNull()
    expect(migrateWorkbench('7')).toBeNull()
  })
})
