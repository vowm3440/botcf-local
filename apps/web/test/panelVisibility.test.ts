import { describe, expect, it } from 'vitest'
import {
  ALL_HIDDEN,
  IDE_PANELS,
  isIdePanelId,
  panelMeta,
  parseStoredVisibility,
  serializeVisibility,
  setPanel,
  togglePanel,
  visiblePanels
} from '../src/panels/panelVisibility'

/** Panel visibility is persisted, so the parse path has to survive whatever is in
 *  localStorage — including entries written by an older version. */

describe('parseStoredVisibility', () => {
  it('treats missing or corrupt storage as everything closed', () => {
    expect(parseStoredVisibility(null)).toEqual(ALL_HIDDEN)
    expect(parseStoredVisibility('not json')).toEqual(ALL_HIDDEN)
    expect(parseStoredVisibility('42')).toEqual(ALL_HIDDEN)
  })

  it('reads the id-list form', () => {
    const visibility = parseStoredVisibility(JSON.stringify(['git', 'terminal']))
    expect(visiblePanels(visibility)).toEqual(['git', 'terminal'])
  })

  it('reads the record form and ignores unknown ids', () => {
    const visibility = parseStoredVisibility(JSON.stringify({ git: true, nope: true, tasks: false }))
    expect(visiblePanels(visibility)).toEqual(['git'])
  })

  it('round-trips through serialization', () => {
    const visibility = setPanel(setPanel(ALL_HIDDEN, 'review', true), 'diagnostics', true)
    expect(parseStoredVisibility(serializeVisibility(visibility))).toEqual(visibility)
  })
})

describe('togglePanel / setPanel', () => {
  it('toggles one panel without touching the others', () => {
    const opened = togglePanel(ALL_HIDDEN, 'tasks')
    expect(opened.tasks).toBe(true)
    expect(visiblePanels(opened)).toEqual(['tasks'])
    expect(togglePanel(opened, 'tasks')).toEqual(ALL_HIDDEN)
  })

  it('returns the same object when nothing changes', () => {
    expect(setPanel(ALL_HIDDEN, 'git', false)).toBe(ALL_HIDDEN)
  })

  it('lists panels in the declared order, not the toggle order', () => {
    const visibility = setPanel(setPanel(ALL_HIDDEN, 'config', true), 'review', true)
    expect(visiblePanels(visibility)).toEqual(['review', 'config'])
  })
})

describe('panel metadata', () => {
  it('describes every panel with a label, a title and a hint', () => {
    for (const panel of IDE_PANELS) {
      expect(panel.label.length).toBeGreaterThan(0)
      expect(panel.title.length).toBeGreaterThan(0)
      expect(panel.hint.length).toBeGreaterThan(0)
      expect(panelMeta(panel.id)).toBe(panel)
    }
  })

  it('recognizes only known panel ids', () => {
    expect(isIdePanelId('git')).toBe(true)
    expect(isIdePanelId('editor')).toBe(false)
    expect(isIdePanelId(7)).toBe(false)
  })
})
