import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetDraftsForTests,
  clearSpilledDraft,
  draftBytes,
  evictStaleDrafts,
  getDraft,
  restoreRecoveredDraft,
  restoreSpilledDraft,
  setDraft,
  setDraftRecovery,
  spillStats
} from '../src/editor/draftStore'

const chunk = (size: number): string => 'd'.repeat(size)

afterEach(() => {
  __resetDraftsForTests()
})

describe('draftStore byte budget and spill recovery', () => {
  it('tracks retained bytes', () => {
    setDraft('a.ts', { content: chunk(10), baseMtimeMs: 1 })
    setDraft('b.ts', { content: chunk(20), baseMtimeMs: 2 })
    expect(draftBytes()).toBe(30)
  })

  it('spills stale (closed) drafts over the budget and drops them in-memory', () => {
    setDraft('closed.ts', { content: chunk(1000), baseMtimeMs: 1 })
    setDraft('open.ts', { content: chunk(1000), baseMtimeMs: 2 })
    const spilled = evictStaleDrafts(['open.ts'], 1200)
    expect(spilled).toEqual(['closed.ts'])
    expect(getDraft('closed.ts')).toBeUndefined()
    // The open draft is protected.
    expect(getDraft('open.ts')).toBeDefined()
    expect(draftBytes()).toBe(1000)
  })

  it('evicts oldest stale draft first', () => {
    setDraft('older.ts', { content: chunk(800), baseMtimeMs: 1 })
    setDraft('newer.ts', { content: chunk(800), baseMtimeMs: 2 })
    setDraft('open.ts', { content: chunk(800), baseMtimeMs: 3 })
    const spilled = evictStaleDrafts(['open.ts'], 1200)
    // 2400 B retained, budget 1200: both stale drafts must go, oldest first.
    expect(spilled).toEqual(['older.ts', 'newer.ts'])
  })

  it('restores a spilled draft with its base mtime for the conflict path', () => {
    setDraft('gone.ts', { content: 'unsaved edits', baseMtimeMs: 42 })
    evictStaleDrafts([], 0)
    const restored = restoreSpilledDraft('gone.ts')
    expect(restored).toEqual({ content: 'unsaved edits', baseMtimeMs: 42 })
  })

  it('clears the spill row on save/discard', () => {
    setDraft('gone.ts', { content: 'x', baseMtimeMs: 1 })
    evictStaleDrafts([], 0)
    expect(restoreSpilledDraft('gone.ts')).toBeDefined()
    clearSpilledDraft('gone.ts')
    expect(restoreSpilledDraft('gone.ts')).toBeUndefined()
  })

  it('keeps the spill cache itself byte-bounded (retained delta stays flat)', () => {
    // Many closed drafts, each bigger than the budget slice they are given: the
    // recovery cache evicts oldest snapshots so total retained bytes never grow
    // past the doc-cache budget.
    for (let i = 0; i < 90; i++) {
      setDraft(`closed-${i}.ts`, { content: chunk(1024 * 1024), baseMtimeMs: i })
      evictStaleDrafts(['open.ts'], 0)
    }
    const stats = spillStats()
    expect(stats.bytes).toBeLessThanOrEqual(stats.budgetBytes)
    // The recovery cache is a byte LRU: entries cap at ~budget/1 MiB, never 90.
    expect(stats.entries).toBeLessThanOrEqual(64)
  })
})

describe('draftStore disk recovery log adapter', () => {
  it('mirrors evicted drafts to the adapter and drops the log on save/discard', async () => {
    const persisted: Array<{ path: string; content: string; baseMtimeMs: number }> = []
    const dropped: string[] = []
    setDraftRecovery({
      fetch: async () => null,
      persist: async (path, draft) => {
        persisted.push({ path, content: draft.content, baseMtimeMs: draft.baseMtimeMs })
      },
      drop: async (path) => {
        dropped.push(path)
      }
    })

    setDraft('closed.ts', { content: chunk(1000), baseMtimeMs: 7 })
    const spilled = evictStaleDrafts([], 0)
    expect(spilled).toEqual(['closed.ts'])
    // The persist is fire-and-forget; let the microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(persisted).toEqual([{ path: 'closed.ts', content: chunk(1000), baseMtimeMs: 7 }])

    clearSpilledDraft('closed.ts')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dropped).toEqual(['closed.ts'])
    // The in-memory row and spill are still gone either way.
    expect(getDraft('closed.ts')).toBeUndefined()
    expect(restoreSpilledDraft('closed.ts')).toBeUndefined()
  })

  it('leaves eviction untouched when no adapter is installed', () => {
    setDraft('closed.ts', { content: chunk(1000), baseMtimeMs: 1 })
    expect(evictStaleDrafts([], 0)).toEqual(['closed.ts'])
    expect(restoreSpilledDraft('closed.ts')).toBeDefined()
  })

  it('fetches a recovery entry through the adapter', async () => {
    setDraftRecovery({
      fetch: async () => ({ content: 'disk draft', baseMtimeMs: 99, diskMtimeMs: 99 }),
      persist: async () => undefined,
      drop: async () => undefined
    })
    expect(await restoreRecoveredDraft('gone.ts')).toEqual({ content: 'disk draft', baseMtimeMs: 99, diskMtimeMs: 99 })
  })

  it('reads nothing when no adapter is installed', async () => {
    expect(await restoreRecoveredDraft('gone.ts')).toBeNull()
  })

  it('treats a failing adapter as no recovery entry', async () => {
    setDraftRecovery({
      fetch: async () => {
        throw new Error('server down')
      },
      persist: async () => undefined,
      drop: async () => undefined
    })
    expect(await restoreRecoveredDraft('gone.ts')).toBeNull()
  })
})
