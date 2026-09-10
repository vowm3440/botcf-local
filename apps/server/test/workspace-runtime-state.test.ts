import { describe, expect, it } from 'vitest'
import {
  background,
  closeRoot,
  createRuntimeStates,
  getRoot,
  idleReapCandidates,
  markActive,
  markRestoreFailed,
  reconcileRoots,
  reapToCold,
  registerRoot,
  requestActivate,
  setBusy,
  setPinned,
  DEFAULT_IDLE_COLD_MS,
  RELEASE_ORDER
} from '../src/workspace/runtimeState.js'

const NOW = 1_000_000

describe('workspace runtime state machine', () => {
  it('registers roots cold and keeps registration idempotent', () => {
    let states = createRuntimeStates()
    states = registerRoot(states, 'a')
    states = registerRoot(states, 'b')
    states = registerRoot(states, 'a')
    expect(states.entries).toHaveLength(2)
    expect(getRoot(states, 'a')).toMatchObject({ rootId: 'a', status: 'cold', pinned: false, busy: false })
    expect(getRoot(states, 'a')?.lastActiveAt).toBeNull()
  })

  it('activates cold roots through restoring to active', () => {
    let states = createRuntimeStates()
    states = registerRoot(states, 'a')
    states = requestActivate(states, 'a')
    expect(getRoot(states, 'a')?.status).toBe('restoring')
    states = markActive(states, 'a', NOW)
    expect(getRoot(states, 'a')).toMatchObject({ status: 'active', lastActiveAt: NOW })
    // Re-activating an active root is a no-op that keeps the timestamp.
    states = markActive(states, 'a', NOW + 5)
    expect(getRoot(states, 'a')?.lastActiveAt).toBe(NOW)
  })

  it('sends an active root to background when focus leaves, and can restore it', () => {
    let states = createRuntimeStates()
    states = registerRoot(states, 'a')
    states = requestActivate(states, 'a')
    states = markActive(states, 'a', NOW)
    states = background(states, 'a', NOW + 100)
    expect(getRoot(states, 'a')).toMatchObject({ status: 'background', backgroundSince: NOW + 100 })
    // Background roots can be activated again (fast path back to active).
    states = requestActivate(states, 'a')
    expect(getRoot(states, 'a')?.status).toBe('restoring')
    states = markActive(states, 'a', NOW + 200)
    expect(getRoot(states, 'a')).toMatchObject({ status: 'active', backgroundSince: null })
  })

  it('reaps only background roots that are idle, unpinned and not busy', () => {
    let states = createRuntimeStates()
    for (const id of ['old', 'busy', 'pinned', 'recent', 'cold']) {
      states = registerRoot(states, id)
      states = requestActivate(states, id)
      states = markActive(states, id, NOW)
    }
    // All five go background at different moments.
    states = background(states, 'old', NOW)
    states = background(states, 'busy', NOW)
    states = background(states, 'pinned', NOW)
    states = background(states, 'recent', NOW + DEFAULT_IDLE_COLD_MS - 1)
    states = background(states, 'cold', NOW)
    states = reapToCold(states, 'cold') // already back to cold manually

    states = setBusy(states, 'busy', true)
    states = setPinned(states, 'pinned', true)

    const candidates = idleReapCandidates(states, NOW + DEFAULT_IDLE_COLD_MS)
    expect(candidates.map((entry) => entry.rootId)).toEqual(['old'])
  })

  it('returns the longest-idle background root first', () => {
    let states = createRuntimeStates()
    for (const id of ['first', 'second']) {
      states = registerRoot(states, id)
      states = requestActivate(states, id)
      states = markActive(states, id, NOW)
    }
    states = background(states, 'first', NOW)
    states = background(states, 'second', NOW + 10)
    const candidates = idleReapCandidates(states, NOW + DEFAULT_IDLE_COLD_MS + 100)
    expect(candidates.map((entry) => entry.rootId)).toEqual(['first', 'second'])
  })

  it('never auto-reaps a pinned root even after its idle window', () => {
    let states = createRuntimeStates()
    states = registerRoot(states, 'keep')
    states = requestActivate(states, 'keep')
    states = markActive(states, 'keep', NOW)
    states = background(states, 'keep', NOW)
    states = setPinned(states, 'keep', true)
    expect(idleReapCandidates(states, NOW + DEFAULT_IDLE_COLD_MS * 10)).toEqual([])
    states = setPinned(states, 'keep', false)
    expect(idleReapCandidates(states, NOW + DEFAULT_IDLE_COLD_MS * 10).map((e) => e.rootId)).toEqual(['keep'])
  })

  it('a failed restore returns the root to cold', () => {
    let states = createRuntimeStates()
    states = registerRoot(states, 'a')
    states = requestActivate(states, 'a')
    expect(getRoot(states, 'a')?.status).toBe('restoring')
    states = markRestoreFailed(states, 'a')
    expect(getRoot(states, 'a')?.status).toBe('cold')
  })

  it('closes roots from any status and keeps a capped recovery log', () => {
    let states = createRuntimeStates()
    for (const id of ['active', 'background', 'cold']) {
      states = registerRoot(states, id)
      states = requestActivate(states, id)
      states = markActive(states, id, NOW)
    }
    states = background(states, 'background', NOW + 10)
    states = closeRoot(states, 'active', NOW + 20)
    states = closeRoot(states, 'background', NOW + 21)
    states = closeRoot(states, 'cold', NOW + 22)
    expect(states.entries).toHaveLength(0)
    expect(states.closedLog.map((log) => log.rootId)).toEqual(['active', 'background', 'cold'])
    expect(states.closedLog[0]?.closedAt).toBe(NOW + 20)
  })

  it('reconcileRoots registers new roots and closes removed ones', () => {
    let states = createRuntimeStates()
    states = registerRoot(states, 'gone')
    states = reconcileRoots(states, ['kept', 'fresh'], NOW)
    expect(states.entries.map((entry) => entry.rootId).sort()).toEqual(['fresh', 'kept'])
    expect(states.closedLog.map((log) => log.rootId)).toEqual(['gone'])
  })

  it('keeps the release order contract stable', () => {
    expect(RELEASE_ORDER).toEqual([
      'stop-new-requests',
      'cancel-in-flight',
      'save-state',
      'close-subscriptions',
      'destroy-views',
      'kill-tree',
      'drop-cache-references'
    ])
  })
})
