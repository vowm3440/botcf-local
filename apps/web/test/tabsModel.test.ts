import { describe, expect, it } from 'vitest'
import {
  EMPTY_TABS,
  TabsState,
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  cycleTab,
  moveTab,
  openTab,
  parseStoredTabs,
  serializeTabs
} from '../src/editor/tabsModel'

function tabs(paths: string[], activePath: string | null): TabsState {
  return { paths, activePath }
}

describe('openTab', () => {
  it('opens and focuses a new path', () => {
    expect(openTab(EMPTY_TABS, 'src/a.ts')).toEqual(tabs(['src/a.ts'], 'src/a.ts'))
  })

  it('appends without disturbing the existing order', () => {
    const state = openTab(openTab(EMPTY_TABS, 'a'), 'b')
    expect(state).toEqual(tabs(['a', 'b'], 'b'))
  })

  it('focuses an already open path in place', () => {
    const state = tabs(['a', 'b', 'c'], 'c')
    expect(openTab(state, 'a')).toEqual(tabs(['a', 'b', 'c'], 'a'))
  })

  it('returns the same object when nothing changes', () => {
    const state = tabs(['a'], 'a')
    expect(openTab(state, 'a')).toBe(state)
  })

  it('ignores an empty path', () => {
    const state = tabs(['a'], 'a')
    expect(openTab(state, '')).toBe(state)
  })

  it('evicts the oldest tab past the cap', () => {
    const state = tabs(['a', 'b', 'c'], 'c')
    expect(openTab(state, 'd', { maxTabs: 3 })).toEqual(tabs(['b', 'c', 'd'], 'd'))
  })

  it('never evicts a protected (unsaved) tab', () => {
    const state = tabs(['a', 'b', 'c'], 'c')
    expect(openTab(state, 'd', { maxTabs: 3, keep: ['a'] })).toEqual(tabs(['a', 'c', 'd'], 'd'))
  })

  it('keeps the new tab when every existing tab is protected', () => {
    const state = tabs(['a', 'b'], 'b')
    expect(openTab(state, 'c', { maxTabs: 2, keep: ['a', 'b'] })).toEqual(tabs(['a', 'b', 'c'], 'c'))
  })
})

describe('closeTab', () => {
  it('focuses the tab on the right', () => {
    expect(closeTab(tabs(['a', 'b', 'c'], 'b'), 'b')).toEqual(tabs(['a', 'c'], 'c'))
  })

  it('focuses the tab on the left when closing the last one', () => {
    expect(closeTab(tabs(['a', 'b'], 'b'), 'b')).toEqual(tabs(['a'], 'a'))
  })

  it('keeps the active tab when closing a different one', () => {
    expect(closeTab(tabs(['a', 'b', 'c'], 'c'), 'a')).toEqual(tabs(['b', 'c'], 'c'))
  })

  it('empties completely on the last tab', () => {
    expect(closeTab(tabs(['a'], 'a'), 'a')).toEqual(EMPTY_TABS)
  })

  it('ignores unknown paths', () => {
    const state = tabs(['a'], 'a')
    expect(closeTab(state, 'zzz')).toBe(state)
  })
})

describe('closeOtherTabs / closeAllTabs', () => {
  it('keeps only the requested tab', () => {
    expect(closeOtherTabs(tabs(['a', 'b', 'c'], 'a'), 'b')).toEqual(tabs(['b'], 'b'))
  })

  it('ignores an unknown path', () => {
    const state = tabs(['a'], 'a')
    expect(closeOtherTabs(state, 'zzz')).toBe(state)
  })

  it('closes everything', () => {
    expect(closeAllTabs()).toEqual(EMPTY_TABS)
  })
})

describe('activateTab', () => {
  it('activates an open tab', () => {
    expect(activateTab(tabs(['a', 'b'], 'a'), 'b')).toEqual(tabs(['a', 'b'], 'b'))
  })

  it('ignores unknown or already active tabs', () => {
    const state = tabs(['a', 'b'], 'a')
    expect(activateTab(state, 'zzz')).toBe(state)
    expect(activateTab(state, 'a')).toBe(state)
  })
})

describe('cycleTab', () => {
  it('wraps forward and backward', () => {
    expect(cycleTab(tabs(['a', 'b', 'c'], 'c'), 1).activePath).toBe('a')
    expect(cycleTab(tabs(['a', 'b', 'c'], 'a'), -1).activePath).toBe('c')
    expect(cycleTab(tabs(['a', 'b', 'c'], 'a'), 1).activePath).toBe('b')
  })

  it('handles an empty set and a missing active tab', () => {
    expect(cycleTab(EMPTY_TABS, 1)).toEqual(EMPTY_TABS)
    expect(cycleTab(tabs(['a', 'b'], null), 1).activePath).toBe('b')
  })
})

describe('moveTab', () => {
  it('moves a tab before another', () => {
    expect(moveTab(tabs(['a', 'b', 'c'], 'a'), 'c', 'a').paths).toEqual(['c', 'a', 'b'])
  })

  it('moves a tab to the end when no anchor is given', () => {
    expect(moveTab(tabs(['a', 'b', 'c'], 'a'), 'a', null).paths).toEqual(['b', 'c', 'a'])
  })

  it('keeps the active tab through a reorder', () => {
    expect(moveTab(tabs(['a', 'b', 'c'], 'b'), 'c', 'a').activePath).toBe('b')
  })

  it('ignores unknown paths and self anchors', () => {
    const state = tabs(['a', 'b'], 'a')
    expect(moveTab(state, 'zzz', 'a')).toBe(state)
    expect(moveTab(state, 'a', 'a')).toBe(state)
    expect(moveTab(state, 'a', 'zzz')).toBe(state)
  })
})

describe('parseStoredTabs', () => {
  it('round-trips a state', () => {
    const state = tabs(['a', 'b'], 'b')
    expect(parseStoredTabs(serializeTabs(state))).toEqual(state)
  })

  it('drops duplicates and non-strings', () => {
    const parsed = parseStoredTabs(JSON.stringify({ paths: ['a', 'a', 3, '', 'b'], activePath: 'b' }))
    expect(parsed).toEqual(tabs(['a', 'b'], 'b'))
  })

  it('falls back to the last tab when the stored active tab is gone', () => {
    expect(parseStoredTabs(JSON.stringify({ paths: ['a', 'b'], activePath: 'missing' })).activePath).toBe('b')
  })

  it('returns nothing for junk input', () => {
    expect(parseStoredTabs(null)).toEqual(EMPTY_TABS)
    expect(parseStoredTabs('not json')).toEqual(EMPTY_TABS)
    expect(parseStoredTabs('{"paths":"a"}')).toEqual(EMPTY_TABS)
    expect(parseStoredTabs(JSON.stringify({ paths: [] }))).toEqual(EMPTY_TABS)
  })
})
