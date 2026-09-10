import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { RootRuntimeController, DEFAULT_RUNTIME_CAPACITY } from '../src/workspace/rootRuntime.js'
import { addRoot, EMPTY_WORKSPACE, type Workspace } from '../src/workspace/model.js'
import { createRuntimeStates } from '../src/workspace/runtimeState.js'
import type { PoolRuntime } from '../src/omp/pool.js'

/** Build a workspace with n absolute-path roots; the first becomes primary. */
function workspaceOf(count: number, prefix = 'proj'): Workspace {
  let workspace = EMPTY_WORKSPACE
  for (let i = 0; i < count; i++) {
    const result = addRoot(workspace, { path: path.resolve(prefix, `dir${i}`) })
    if (!result.ok) throw new Error(result.error)
    workspace = result.workspace
  }
  return workspace
}

function makePrimary(workspace: Workspace, id: string): Workspace {
  const root = workspace.roots.find((entry) => entry.id === id)
  if (!root) throw new Error('no such root')
  return { roots: workspace.roots, primaryId: root.id }
}

class FakeRuntime implements PoolRuntime {
  available = true
  running = false
  lastError: string | null = null
  startCalls = 0
  stopCalls = 0
  async start(): Promise<boolean> {
    this.startCalls += 1
    if (!this.available) return false
    this.running = true
    return true
  }
  async stop(): Promise<void> {
    this.stopCalls += 1
    this.running = false
  }
  async handshake(): Promise<boolean> {
    return true
  }
}

interface Harness {
  controller: RootRuntimeController
  runtimes: Map<string, FakeRuntime>
  running: () => string[]
  dispose: () => void
}

function harness(capacity = 2, idleMs = 60_000): Harness {
  const runtimes = new Map<string, FakeRuntime>()
  const controller = new RootRuntimeController({
    capacity,
    idleMs,
    sweepMs: 60_000,
    factory: (rootId) => {
      const runtime = new FakeRuntime()
      runtimes.set(rootId, runtime)
      return runtime
    }
  })
  const running = (): string[] => [...runtimes.entries()].filter(([, runtime]) => runtime.running).map(([id]) => id).sort()
  return { controller, runtimes, running, dispose: () => controller.shutdown() }
}

/** Mirror the boot/restart path: sync the workspace, then start the active root
 *  and mark the activation complete. */
async function activate(harness: Harness, workspace: Workspace): Promise<void> {
  harness.controller.syncWorkspace(workspace)
  await harness.controller.startActive()
  harness.controller.completeActivation()
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('root runtime controller (state machine + pool)', () => {
  it('opens 8 roots but runs only the one being operated', async () => {
    const h = harness()
    try {
      const workspace = workspaceOf(8)
      await activate(h, workspace)
      const snapshot = h.controller.snapshot()
      expect(snapshot.running).toBe(1)
      expect(h.running()).toEqual([workspace.roots[0].id])
      // Every other root is registered but cold — opening a directory must not
      // spawn an OMP process (stage-3 acceptance #1).
      expect(snapshot.roots).toHaveLength(8)
      expect(snapshot.roots.filter((entry) => entry.status === 'cold')).toHaveLength(7)
      expect(snapshot.roots.find((entry) => entry.rootId === workspace.primaryId)?.status).toBe('active')
    } finally {
      await h.dispose()
    }
  })

  it('keeps the outgoing root warm, then recycles the first root when a third takes focus', async () => {
    const h = harness(2)
    try {
      const w = workspaceOf(3)
      const [a, b, c] = w.roots.map((root) => root.id)

      await activate(h, w) // a active
      await activate(h, makePrimary(w, b)) // a parked warm, b active
      expect(h.running().sort()).toEqual([a, b].sort())
      const aRuntime = h.runtimes.get(a)!
      expect(aRuntime.running).toBe(true) // warm retention

      await activate(h, makePrimary(w, c)) // capacity: recycle the oldest parked (a)
      expect(h.running().sort()).toEqual([b, c].sort())
      expect(aRuntime.running).toBe(false)
      const snapshot = h.controller.snapshot()
      expect(snapshot.roots.find((entry) => entry.rootId === a)?.status).toBe('cold')
      expect(snapshot.roots.find((entry) => entry.rootId === c)?.status).toBe('active')
    } finally {
      await h.dispose()
    }
  })

  it('never recycles a pinned root, and evicts the unpinned one instead', async () => {
    const h = harness(2)
    try {
      const w = workspaceOf(3)
      const [a, b, c] = w.roots.map((root) => root.id)

      await activate(h, w) // a active
      h.controller.setPinned(a, true)
      await activate(h, makePrimary(w, b)) // a parked but pinned → retained
      expect(h.running().sort()).toEqual([a, b].sort())

      await activate(h, makePrimary(w, c)) // capacity full (a pinned) → evict b
      expect(h.running().sort()).toEqual([a, c].sort())
      expect(h.runtimes.get(a)!.running).toBe(true) // pinned root untouched
    } finally {
      await h.dispose()
    }
  })

  it('queues a third activation while two pinned roots hold every slot', async () => {
    const h = harness(2)
    try {
      const w = workspaceOf(3)
      const [a, b, c] = w.roots.map((root) => root.id)

      await activate(h, w)
      h.controller.setPinned(a, true)
      await activate(h, makePrimary(w, b))
      h.controller.setPinned(b, true)

      // Move focus to c while a and b (both pinned) keep running: no slot, so
      // the start is refused and the snapshot reports the root as queued.
      h.controller.syncWorkspace(makePrimary(w, c))
      expect(await h.controller.startActive()).toBe(false)
      let snapshot = h.controller.snapshot()
      expect(h.running().sort()).toEqual([a, b].sort())
      expect(snapshot.queued).toBe(true)
      expect(snapshot.roots.find((entry) => entry.rootId === c)?.queued).toBe(true)

      // Unpinning one root frees the slot: c starts, the unpinned root is recycled.
      h.controller.setPinned(b, false)
      expect(await h.controller.startActive()).toBe(true)
      snapshot = h.controller.snapshot()
      expect(h.running().sort()).toEqual([a, c].sort())
      expect(snapshot.queued).toBe(false)
    } finally {
      await h.dispose()
    }
  })

  it('recycles an idle background root to cold after its window', async () => {
    const h = harness(2, 25)
    try {
      const w = workspaceOf(2)
      const [a, b] = w.roots.map((root) => root.id)
      await activate(h, w)
      await activate(h, makePrimary(w, b))
      expect(h.running().sort()).toEqual([a, b].sort())

      // The outgoing root (a) is parked and running; after the idle window the
      // sweep stops it and the controller marks it cold.
      await sleep(60)
      await h.controller.idleSweep()
      const snapshot = h.controller.snapshot()
      expect(h.runtimes.get(a)!.running).toBe(false)
      expect(snapshot.roots.find((entry) => entry.rootId === a)?.status).toBe('cold')
      expect(snapshot.running).toBe(1)
    } finally {
      await h.dispose()
    }
  })

  it('removing a root closes it and releases its runtime', async () => {
    const h = harness(2)
    try {
      const w = workspaceOf(2)
      const [a, b] = w.roots.map((root) => root.id)
      await activate(h, w)
      await activate(h, makePrimary(w, b))

      // Remove the parked root a: state machine closes it, pool releases it.
      const smaller = { roots: w.roots.filter((root) => root.id !== a), primaryId: b }
      h.controller.syncWorkspace(smaller)
      const snapshot = h.controller.snapshot()
      expect(snapshot.roots.map((entry) => entry.rootId)).toEqual([b])
      expect(snapshot.closedLog.map((log) => log.rootId)).toContain(a)
      expect(h.runtimes.get(a)!.running).toBe(false)
    } finally {
      await h.dispose()
    }
  })

  it('stays within the configured pool capacity', () => {
    expect(DEFAULT_RUNTIME_CAPACITY).toBe(2)
    expect(createRuntimeStates().entries).toEqual([])
  })
})
