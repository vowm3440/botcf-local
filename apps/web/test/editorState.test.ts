import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearDraft,
  draftPaths,
  draftedPaths,
  getDraft,
  setDraft,
  subscribeDrafts
} from '../src/editor/draftStore'
import { getViewerState, pruneViewerStates, rememberViewerState } from '../src/editor/viewerState'

/** Only the front tab keeps a mounted viewer, so the two things a hidden tab must
 *  not lose — its unsaved buffer and the view it was left in — live here rather
 *  than in the component. The tab strip's ● marker reads the draft cache for the
 *  same reason: there is no component behind a hidden tab to ask. */

function reset(): void {
  for (const path of draftPaths()) clearDraft(path)
  pruneViewerStates([])
}

beforeEach(reset)

describe('draftStore', () => {
  it('keeps a buffer across the unmount a tab switch causes', () => {
    setDraft('app/src/a.ts', { content: 'edited', baseMtimeMs: 10 })
    expect(getDraft('app/src/a.ts')).toEqual({ content: 'edited', baseMtimeMs: 10 })
    expect([...draftedPaths()]).toEqual(['app/src/a.ts'])
  })

  it('notifies when a path gains or loses a draft', () => {
    let notified = 0
    const stop = subscribeDrafts(() => { notified += 1 })
    setDraft('a', { content: '1', baseMtimeMs: 0 })
    expect(notified).toBe(1)
    clearDraft('a')
    expect(notified).toBe(2)
    clearDraft('a')
    expect(notified).toBe(2)
    stop()
  })

  it('stays silent while an existing draft only changes content', () => {
    setDraft('a', { content: '1', baseMtimeMs: 0 })
    let notified = 0
    const stop = subscribeDrafts(() => { notified += 1 })
    // Typing must not re-render the workbench: the dirty *set* did not change.
    setDraft('a', { content: '12', baseMtimeMs: 0 })
    setDraft('a', { content: '123', baseMtimeMs: 0 })
    expect(notified).toBe(0)
    stop()
  })

  it('hands out a stable snapshot until the set changes', () => {
    setDraft('a', { content: '1', baseMtimeMs: 0 })
    const snapshot = draftedPaths()
    setDraft('a', { content: '2', baseMtimeMs: 0 })
    // useSyncExternalStore compares by identity; a fresh Set per keystroke would
    // re-render every consumer of the dirty set.
    expect(draftedPaths()).toBe(snapshot)
    setDraft('b', { content: '1', baseMtimeMs: 0 })
    expect(draftedPaths()).not.toBe(snapshot)
    expect([...draftedPaths()].sort()).toEqual(['a', 'b'])
  })

  it('drops a listener once it unsubscribes', () => {
    let notified = 0
    subscribeDrafts(() => { notified += 1 })()
    setDraft('a', { content: '1', baseMtimeMs: 0 })
    expect(notified).toBe(0)
  })
})

describe('viewerState', () => {
  it('remembers the view a tab was left in, and forgets it once the tab is gone', () => {
    rememberViewerState('app/big.ts', { mode: 'inline', line: 4200, fullInline: true })
    expect(getViewerState('app/big.ts')).toEqual({ mode: 'inline', line: 4200, fullInline: true })
    pruneViewerStates([])
    expect(getViewerState('app/big.ts')).toBeUndefined()
  })

  it('keeps the tabs that are still open, and only those', () => {
    rememberViewerState('a', { mode: 'content', line: 12, fullInline: false })
    rememberViewerState('b', { mode: 'diff', line: 1, fullInline: false })
    rememberViewerState('c', { mode: 'inline', line: 90, fullInline: true })
    // 关闭其他:只剩 b。列表里的 missing 从来没有过状态,不该出错。
    pruneViewerStates(['b', 'missing'])
    expect(getViewerState('a')).toBeUndefined()
    expect(getViewerState('c')).toBeUndefined()
    expect(getViewerState('b')).toEqual({ mode: 'diff', line: 1, fullInline: false })
  })

  it('drops a closed tab even though its viewer writes state on the way out', () => {
    rememberViewerState('a', { mode: 'inline', line: 4200, fullInline: true })
    rememberViewerState('b', { mode: 'content', line: 7, fullInline: false })
    // Closing 「a」 while it is in front: the tab set commits first, and only then does
    // the unmounting viewer write where it was left. Deleting on the click therefore
    // loses the race — this write is the one that used to survive its own tab.
    rememberViewerState('a', { mode: 'inline', line: 4300, fullInline: true })
    pruneViewerStates(['b'])
    expect(getViewerState('a')).toBeUndefined()
    expect(getViewerState('b')?.line).toBe(7)
  })

  it('leaves surviving entries untouched', () => {
    rememberViewerState('a', { mode: 'content', line: 12, fullInline: false })
    const kept = getViewerState('a')
    pruneViewerStates(['a'])
    expect(getViewerState('a')).toBe(kept)
    pruneViewerStates(['a', 'b'])
    expect(getViewerState('a')).toBe(kept)
  })
})
