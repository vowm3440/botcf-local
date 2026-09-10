import { EventEmitter } from 'node:events'

/** One root's agent runtime, seen through the pool.
 *
 *  The pool treats the handle opaquely: it creates it lazily per root, starts it
 *  on activation, stops it on idle-reap / release, and never inspects the
 *  process underneath. Tests inject scripted doubles; the server injects an
 *  adapter over a real `OmpRpcClient`. */
export interface PoolRuntime {
  /** False when there is no binary to spawn (direct mode is the fallback). */
  readonly available: boolean
  readonly running: boolean
  readonly lastError: string | null
  start: () => Promise<boolean>
  stop: () => Promise<void>
  /** Verify the RPC handshake; callers keep `started` semantics unchanged. */
  handshake: () => Promise<boolean>
}

export interface PoolRuntimeFactory {
  (rootId: string): PoolRuntime
}

/** Defaults follow the plan's budget table (§4): two parallel AI runtimes and a
 *  five-minute idle window before a background root's process is recycled. Both
 *  are configurable for tests and for machines that need a tighter envelope. */
export const DEFAULT_POOL_CAPACITY = 2
export const DEFAULT_POOL_IDLE_MS = 5 * 60_000
export const DEFAULT_POOL_SWEEP_MS = 1_000

export interface PoolSnapshotEntry {
  rootId: string
  running: boolean
  pinned: boolean
  /** Leases held by the app (the active root holds one while in focus). */
  leases: number
  /** Clock value when leases last dropped to zero, or null while leased. */
  idleSince: number | null
}

export interface PoolSnapshot {
  capacity: number
  running: number
  entries: PoolSnapshotEntry[]
}

interface PoolEntry {
  rootId: string
  runtime: PoolRuntime
  pinned: boolean
  leases: number
  idleSince: number | null
}

export interface OmpPoolOptions {
  factory: PoolRuntimeFactory
  capacity?: number
  idleMs?: number
  sweepMs?: number
  /** Test seams: the idle sweep otherwise runs on the real clock. */
  now?: () => number
  timers?: { setTimeout: (cb: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void }
}

/** Per-root agent runtime pool (docs/lightweight-ide-resource-plan.md §3).
 *
 *  - At most `capacity` runtimes run at once; the app's focus root always gets a
 *    slot, evicting a parked (lease-free, unpinned) process first.
 *  - A root that loses focus is *parked*: its process is kept warm for the idle
 *    window so switching back is fast, then recycled by the sweep.
 *  - Pinned roots are never recycled by the sweep and are never chosen as an
 *    eviction victim; pinning more roots than the capacity is what makes a later
 *    activation wait (the UI shows it as 排队中).
 *
 *  Everything is observable through `snapshot()` for the badge UI. */
export class OmpRuntimePool extends EventEmitter {
  private _capacity: number

  /** Current parallel-AI capacity. The resource degrader shrinks it under
   *  memory pressure and restores it afterwards (plan \u00a74). */
  get capacity(): number {
    return this._capacity
  }
  readonly idleMs: number
  private readonly sweepMs: number
  private readonly now: () => number
  private readonly timers: NonNullable<OmpPoolOptions['timers']>
  private readonly factory: PoolRuntimeFactory
  private readonly entries = new Map<string, PoolEntry>()
  private sweepTimer: unknown | null = null

  constructor(options: OmpPoolOptions) {
    super()
    this.factory = options.factory
    this._capacity = Math.max(1, options.capacity ?? DEFAULT_POOL_CAPACITY)
    this.idleMs = Math.max(0, options.idleMs ?? DEFAULT_POOL_IDLE_MS)
    this.sweepMs = Math.max(50, options.sweepMs ?? DEFAULT_POOL_SWEEP_MS)
    this.now = options.now ?? (() => Date.now())
    this.timers = options.timers ?? { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout) }
    this.startSweep()
  }

  private startSweep(): void {
    if (this.sweepTimer !== null) return
    this.sweepTimer = this.timers.setTimeout(() => {
      this.sweepTimer = null
      void this.idleSweep().catch(() => undefined)
      this.startSweep()
    }, this.sweepMs)
  }

  /** Lower (or raise) the pool ceiling. Lowering evicts parked, unpinned
   *  runtimes until running count fits; pinned and leased roots are kept (the
   *  lease-holder is the app's focus and always keeps its slot). Used by the
   *  resource degrader when the machine runs out of memory. */
  async setCapacity(next: number): Promise<void> {
    const capped = Math.max(1, Math.floor(next))
    if (capped === this._capacity) return
    this._capacity = capped
    for (const victim of this.evictionCandidates()) {
      if (this.runningCount() <= capped) break
      await this.stopEntry(victim)
    }
    this.emitChange()
  }

  entry(rootId: string): PoolEntry | null {
    return this.entries.get(rootId) ?? null
  }

  /** Create (or reuse) the entry for a root and take one lease on it. Starting
   *  the process is the caller's job (via `start`), so a bind that happens while
   *  another root is being handed the focus never spawns anything by itself. */
  bind(rootId: string): PoolRuntime {
    let entry = this.entries.get(rootId)
    if (!entry) {
      entry = { rootId, runtime: this.factory(rootId), pinned: false, leases: 0, idleSince: null }
      this.entries.set(rootId, entry)
    }
    entry.leases += 1
    entry.idleSince = null
    this.emitChange()
    return entry.runtime
  }

  /** The focus left the root: release the lease. The process stays up (warm
   *  retention) unless `stopNow` asks for an immediate recycle — used when a
   *  generation is in flight and the process must not linger on a session the
   *  user walked away from. */
  park(rootId: string, options: { stopNow?: boolean } = {}): void {
    const entry = this.entries.get(rootId)
    if (!entry) return
    entry.leases = Math.max(0, entry.leases - 1)
    if (entry.leases === 0) entry.idleSince = this.now()
    if (options.stopNow) {
      entry.idleSince = this.now()
      void this.stopEntry(entry).catch(() => undefined)
    }
    this.emitChange()
  }

  /** Refresh the lease without starting: an already-running root that regains
   *  focus must not fall into the idle window. */
  touch(rootId: string): void {
    const entry = this.entries.get(rootId)
    if (!entry) return
    entry.leases = Math.max(1, entry.leases)
    entry.idleSince = null
    this.emitChange()
  }

  setPin(rootId: string, pinned: boolean): void {
    const entry = this.entries.get(rootId)
    if (!entry || entry.pinned === pinned) return
    entry.pinned = pinned
    // Unpinning restarts the idle window from now, so a just-unpinned root is
    // not recycled the instant the next sweep runs.
    if (!pinned && entry.leases === 0) entry.idleSince = this.now()
    this.emitChange()
  }

  /** Parked, unpinned, running entries, oldest idle first — the eviction order
   *  used when an activation needs a slot. */
  private evictionCandidates(): PoolEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.leases === 0 && !entry.pinned && entry.runtime.running)
      .sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0))
  }

  /** Start a root's runtime, keeping the whole pool under `capacity`. When every
   *  slot is held by pinned roots this returns false — the caller falls back to
   *  direct mode and the UI reports the activation as queued. */
  async start(rootId: string): Promise<boolean> {
    let entry = this.entries.get(rootId)
    if (!entry) {
      this.bind(rootId)
      entry = this.entries.get(rootId)
    }
    if (!entry) return false
    if (entry.runtime.running) return true
    if (!entry.runtime.available) return false

    while (this.runningCount() >= this.capacity) {
      const victim = this.evictionCandidates()[0]
      if (!victim) return false
      await this.stopEntry(victim)
    }
    const started = await entry.runtime.start()
    if (started) await entry.runtime.handshake().catch(() => false)
    this.emitChange()
    return started
  }

  /** Stop one root's process (used by release and forced parks). */
  private async stopEntry(entry: PoolEntry): Promise<void> {
    if (!entry.runtime.running) return
    await entry.runtime.stop().catch(() => undefined)
    this.emitChange()
  }

  /** Stop a root's runtime but keep its entry (leases, pin) intact. */
  async stop(rootId: string): Promise<void> {
    const entry = this.entries.get(rootId)
    if (!entry) return
    entry.idleSince = this.now()
    await this.stopEntry(entry)
  }

  /** Root left the workspace: stop its process and drop every trace of it. */
  async release(rootId: string): Promise<void> {
    const entry = this.entries.get(rootId)
    if (!entry) return
    await this.stopEntry(entry)
    this.entries.delete(rootId)
    this.emitChange()
  }

  /** Recycle background processes whose idle window elapsed. Pinned roots are
   *  skipped. Called by the sweep loop and by tests directly. */
  async idleSweep(): Promise<void> {
    const now = this.now()
    const expired = [...this.entries.values()].filter(
      (entry) => entry.leases === 0 && !entry.pinned && entry.runtime.running && entry.idleSince !== null && now - entry.idleSince >= this.idleMs
    )
    for (const entry of expired) {
      await this.stopEntry(entry)
      this.entries.delete(entry.rootId)
    }
    if (expired.length > 0) this.emitChange()
  }

  runningCount(): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.runtime.running) count += 1
    return count
  }

  /** How many roots currently hold a lease (the app's active focus set). */
  leasedCount(): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.leases > 0) count += 1
    return count
  }

  snapshot(): PoolSnapshot {
    return {
      capacity: this.capacity,
      running: this.runningCount(),
      entries: [...this.entries.values()]
        .map((entry) => ({
          rootId: entry.rootId,
          running: entry.runtime.running,
          pinned: entry.pinned,
          leases: entry.leases,
          idleSince: entry.idleSince
        }))
        .sort((a, b) => a.rootId.localeCompare(b.rootId))
    }
  }

  /** Stop every runtime (process shutdown). */
  async stopAll(): Promise<void> {
    const all = [...this.entries.values()]
    for (const entry of all) await this.stopEntry(entry)
    this.entries.clear()
    this.emitChange()
  }

  dispose(): void {
    if (this.sweepTimer !== null) {
      this.timers.clearTimeout(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  private emitChange(): void {
    this.emit('change', this.snapshot())
  }
}
