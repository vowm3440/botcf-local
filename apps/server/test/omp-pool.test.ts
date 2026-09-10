import { describe, expect, it, vi } from 'vitest'
import { OmpRuntimePool, type PoolRuntime } from '../src/omp/pool.js'

/** Scripted runtime double: start/stop flip `running` and are recorded, so
 *  tests can assert exactly which roots were spawned and recycled. */
class FakeRuntime implements PoolRuntime {
  available = true
  running = false
  lastError: string | null = null
  startCalls = 0
  stopCalls = 0
  handshakes = 0
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
    this.handshakes += 1
    return true
  }
}

function harness(capacity: number, idleMs = 60_000) {
  const runtimes = new Map<string, FakeRuntime>()
  const pool = new OmpRuntimePool({
    capacity,
    idleMs,
    sweepMs: 60_000,
    factory: (rootId) => {
      const runtime = new FakeRuntime()
      runtimes.set(rootId, runtime)
      return runtime
    }
  })
  const started = (): string[] => [...runtimes.entries()].filter(([, r]) => r.running).map(([id]) => id).sort()
  return { pool, runtimes, started }
}

describe('omp runtime pool', () => {
  it('starts a root on activation and reuses the running process', async () => {
    const { pool, runtimes, started } = harness(2)
    pool.bind('a')
    expect(await pool.start('a')).toBe(true)
    expect(started()).toEqual(['a'])
    const before = runtimes.get('a')!.startCalls
    expect(await pool.start('a')).toBe(true)
    expect(runtimes.get('a')!.startCalls).toBe(before)
    pool.dispose()
  })

  it('keeps the whole pool under capacity by evicting parked roots first', async () => {
    const { pool, started } = harness(2)
    pool.bind('a')
    await pool.start('a')
    pool.park('a') // a loses focus but its process stays warm
    pool.bind('b')
    await pool.start('b')
    pool.park('b')
    expect(started()).toEqual(['a', 'b'])

    // Activating a third root needs a slot: the oldest parked, unpinned root (a)
    // is recycled and c takes its place.
    pool.bind('c')
    expect(await pool.start('c')).toBe(true)
    expect(started()).toEqual(['b', 'c'])
    pool.dispose()
  })

  it('refuses to start beyond capacity when every slot is pinned', async () => {
    const { pool, started } = harness(2)
    pool.bind('a')
    await pool.start('a')
    pool.setPin('a', true)
    pool.bind('b')
    await pool.start('b')
    pool.setPin('b', true)

    pool.park('a')
    pool.park('b')
    expect(started()).toEqual(['a', 'b'])
    pool.bind('c')
    expect(await pool.start('c')).toBe(false)
    // Pinned roots are untouched.
    expect(started()).toEqual(['a', 'b'])
    pool.dispose()
  })

  it('unpinning frees a slot for the next activation', async () => {
    const { pool, started } = harness(2)
    pool.bind('a')
    await pool.start('a')
    pool.setPin('a', true)
    pool.park('a')
    pool.bind('b')
    await pool.start('b')
    pool.setPin('b', true)
    pool.park('b')

    pool.setPin('a', false)
    expect(await pool.start('c')).toBe(true)
    expect(started()).toEqual(['b', 'c'])
    pool.dispose()
  })

  it('idle sweep recycles a parked unpinned runtime after its window', async () => {
    const { pool, runtimes, started } = harness(2, 5)
    pool.bind('a')
    await pool.start('a')
    pool.bind('b')
    await pool.start('b')
    pool.setPin('b', true)
    pool.park('a')
    pool.park('b')

    // Before the idle window nothing is recycled.
    await pool.idleSweep()
    expect(started()).toEqual(['a', 'b'])

    // After it, only the unpinned root is recycled; the pinned one survives.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await pool.idleSweep()
    expect(started()).toEqual(['b'])
    expect(runtimes.get('a')!.stopCalls).toBe(1)
    expect(runtimes.get('b')!.stopCalls).toBe(0)
    pool.dispose()
  })

  it('release stops the process and drops the entry', async () => {
    const { pool, runtimes } = harness(2)
    pool.bind('a')
    await pool.start('a')
    await pool.release('a')
    expect(runtimes.get('a')!.running).toBe(false)
    expect(pool.snapshot().entries).toHaveLength(0)
    pool.dispose()
  })

  it('park with stopNow recycles immediately (in-flight switch safety)', async () => {
    const { pool, runtimes } = harness(2)
    pool.bind('a')
    await pool.start('a')
    pool.park('a', { stopNow: true })
    expect(runtimes.get('a')!.running).toBe(false)
    pool.dispose()
  })

  it('stopAll shuts every runtime down', async () => {
    const { pool, runtimes } = harness(4)
    for (const id of ['a', 'b', 'c']) {
      pool.bind(id)
      await pool.start(id)
    }
    await pool.stopAll()
    expect(pool.runningCount()).toBe(0)
    expect(pool.snapshot().entries).toHaveLength(0)
    for (const runtime of runtimes.values()) expect(runtime.running).toBe(false)
    pool.dispose()
  })

  it('does not start when the runtime reports unavailable (direct mode)', async () => {
    const { pool, runtimes } = harness(2)
    runtimes.get('a')?.stop()
    pool.bind('a')
    runtimes.get('a')!.available = false
    expect(await pool.start('a')).toBe(false)
    pool.dispose()
  })

  it('reports snapshot entries and change events', async () => {
    const { pool } = harness(2)
    const onChange = vi.fn()
    pool.on('change', onChange)
    pool.bind('a')
    await pool.start('a')
    expect(pool.runningCount()).toBe(1)
    const snapshot = pool.snapshot()
    expect(snapshot.capacity).toBe(2)
    expect(snapshot.entries[0]).toMatchObject({ rootId: 'a', running: true, pinned: false, leases: 1 })
    expect(onChange).toHaveBeenCalled()
    pool.dispose()
  })
})

describe('pool capacity changes (resource degrader)', () => {
  it('evicts parked unpinned runtimes down to a lowered ceiling', async () => {
    const { pool, started } = harness(2)
    pool.bind('a')
    await pool.start('a')
    pool.park('a')
    pool.bind('b')
    await pool.start('b')
    expect(started()).toEqual(['a', 'b'])
    expect(pool.capacity).toBe(2)
    await pool.setCapacity(1)
    expect(pool.capacity).toBe(1)
    // a was parked first, so it is the eviction victim.
    expect(started()).toEqual(['b'])
    await pool.setCapacity(2)
    expect(pool.capacity).toBe(2)
    pool.dispose()
  })

  it('never evicts the leased (active) root', async () => {
    const { pool, started } = harness(2)
    pool.bind('a') // active lease
    await pool.start('a')
    pool.bind('b')
    await pool.start('b')
    pool.park('b')
    await pool.setCapacity(1)
    expect(started()).toEqual(['a'])
    pool.dispose()
  })

  it('leaves pinned roots running even over the lowered ceiling', async () => {
    const { pool, started } = harness(2)
    pool.bind('a')
    await pool.start('a')
    pool.setPin('a', true)
    pool.park('a')
    pool.bind('b')
    await pool.start('b')
    pool.setPin('b', true)
    pool.park('b')
    await pool.setCapacity(1)
    expect(pool.capacity).toBe(1)
    expect(started()).toEqual(['a', 'b'])
    await pool.setCapacity(2)
    expect(started()).toEqual(['a', 'b'])
    pool.dispose()
  })

  it('clamps a raised/lowered request to at least one slot', async () => {
    const { pool } = harness(2)
    await pool.setCapacity(0)
    expect(pool.capacity).toBe(1)
    pool.dispose()
  })
})
