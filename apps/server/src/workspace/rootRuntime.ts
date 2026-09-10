import { EventEmitter } from 'node:events'
import { appState } from '../appState.js'
import { OmpRuntimePool, type PoolRuntime, type PoolRuntimeFactory } from '../omp/pool.js'
import { OmpRpcClient, ompClient, setActiveOmpClient, setOmpStartGate } from '../omp/rpc.js'
import type { Workspace } from './model.js'
import {
  background as stateBackground,
  createRuntimeStates,
  getRoot,
  idleReapCandidates,
  markActive,
  reapToCold,
  reconcileRoots,
  requestActivate,
  setBusy as stateSetBusy,
  setPinned as stateSetPinned,
  type ClosedRootLogEntry,
  type RootRuntimeStatus,
  type RuntimeStates
} from './runtimeState.js'

/** Per-root runtime orchestration (docs/lightweight-ide-resource-plan.md §3).
 *
 *  One controller owns the two new resource layers:
 *   - `runtimeState` decides per-root lifecycle (cold/restoring/active/
 *     background/closed) and what may be auto-reaped;
 *   - the `OmpRuntimePool` gives every root its own OmpRpcClient (per-root cwd,
 *     hence per-root session files) and caps how many may run at once.
 *
 *  The app itself keeps the pool honest: the *primary* root is the active one
 *  (the chat targets it), and switching primary hands the old root to the pool's
 *  warm-retention window instead of killing it outright. Only the active root's
 *  client is wired into the shared `ompClient` facade, so every pre-existing
 *  route keeps working while background runtimes live and die underneath it.
 */

export const DEFAULT_RUNTIME_CAPACITY = 2
export const DEFAULT_RUNTIME_IDLE_MS = 5 * 60_000

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.round(parsed) : fallback
}

export interface RootRuntimeRootSnapshot {
  rootId: string
  status: RootRuntimeStatus
  pinned: boolean
  busy: boolean
  running: boolean
  /** True when the root is the active one but could not get a slot because every
   *  capacity slot is held by pinned runtimes. */
  queued: boolean
}

export interface RootRuntimeSnapshot {
  activeRootId: string | null
  capacity: number
  running: number
  queued: boolean
  roots: RootRuntimeRootSnapshot[]
  closedLog: ClosedRootLogEntry[]
}

export interface RootRuntimeOptions {
  capacity?: number
  idleMs?: number
  sweepMs?: number
  factory?: PoolRuntimeFactory
}

export class RootRuntimeController extends EventEmitter {
  private readonly pool: OmpRuntimePool
  private readonly capacity: number
  private states: RuntimeStates = createRuntimeStates()
  private activeId: string | null = null
  private readonly paths = new Map<string, string>()
  private readonly clients = new Map<string, OmpRpcClient>()
  private disposed = false

  constructor(options: RootRuntimeOptions = {}) {
    super()
    this.capacity = options.capacity ?? envNumber('OMP_RUNTIME_CAPACITY', DEFAULT_RUNTIME_CAPACITY)
    const idleMs = options.idleMs ?? envNumber('OMP_RUNTIME_IDLE_MS', DEFAULT_RUNTIME_IDLE_MS)
    this.pool = new OmpRuntimePool({
      capacity: this.capacity,
      idleMs,
      sweepMs: options.sweepMs,
      factory: options.factory ?? ((rootId: string) => this.adaptClient(this.ensureClient(rootId)))
    })
    this.pool.on('change', () => this.reconcileFromPool())
    // Facade wiring: the exported ompClient follows whichever root is active and
    // asks the pool for a slot before spawning (direct mode while queued).
    setOmpStartGate(async () => this.ensureSlotForStart())
    setActiveOmpClient(null)
  }

  /** A per-root client carries its own cwd, so the agent's sessions land in the
   *  session directory derived from that project path (the concurrency probe in
   *  .probe-tmp confirmed two instances share one agent dir safely as long as
   *  each runs against its own project path). */
  private ensureClient(rootId: string): OmpRpcClient {
    let client = this.clients.get(rootId)
    if (!client) {
      client = new OmpRpcClient()
      client.workdir = this.paths.get(rootId) ?? null
      this.clients.set(rootId, client)
    }
    return client
  }

  private adaptClient(client: OmpRpcClient): PoolRuntime {
    return {
      get available() {
        return client.available
      },
      get running() {
        return client.running
      },
      get lastError() {
        return client.lastProtocolError
      },
      start: () => client.start(),
      stop: () => client.stop(),
      handshake: () => client.handshake()
    }
  }

  /** Current pool ceiling — read by the resource degrader (differs from the
   *  constructor `capacity` once pressure has lowered it). */
  poolCapacity(): number {
    return this.pool.capacity
  }

  /** Lower/raise the pool ceiling under memory pressure; lowering evicts
   *  background runtimes first. */
  setPoolCapacity(next: number): Promise<void> {
    return this.pool.setCapacity(next)
  }

  private generationInFlight(): boolean {
    return appState.generationInFlight
  }

  /** Reconcile the state machine with the pool after stops/evictions, so a
   *  background root whose process was recycled reads as cold. */
  private reconcileFromPool(): void {
    let changed = false
    let next = this.states
    for (const entry of next.entries) {
      if (entry.status !== 'background') continue
      const poolEntry = this.pool.entry(entry.rootId)
      if (!poolEntry || !poolEntry.runtime.running) {
        next = reapToCold(next, entry.rootId)
        changed = true
      }
    }
    if (changed) {
      this.states = next
      this.emit('change')
    }
  }

  /** The primary root changed (or the workspace was restored): release what left,
   *  park what lost focus, bind the new active root's client. Starting the
   *  process is deliberately left to the callers that already await a start
   *  (boot, restartRuntime) — binding must never spawn anything by itself. */
  syncWorkspace(workspace: Workspace): void {
    if (this.disposed) return
    const now = Date.now()
    const ids = workspace.roots.map((root) => root.id)
    for (const root of workspace.roots) this.paths.set(root.id, root.path)

    const before = new Set(this.states.entries.map((entry) => entry.rootId))
    this.states = reconcileRoots(this.states, ids, now)
    for (const rootId of before) {
      if (!ids.includes(rootId)) {
        void this.pool.release(rootId).catch(() => undefined)
        this.clients.delete(rootId)
      }
    }

    const nextActive = workspace.primaryId
    if (nextActive === this.activeId) return
    if (this.activeId) {
      const previous = this.activeId
      this.states = stateBackground(this.states, previous, now)
      // A running turn must not linger on a session the user walked away from.
      this.pool.park(previous, { stopNow: this.generationInFlight() })
    }
    this.activeId = nextActive
    if (nextActive) {
      this.states = requestActivate(this.states, nextActive)
      this.pool.bind(nextActive)
      this.bindActiveClient()
    } else {
      setActiveOmpClient(null)
    }
    this.emit('change')
  }

  /** Wire the facade to the active root's client and make the pool remember any
   *  pin the state machine carries (pool entries are created lazily). */
  private bindActiveClient(): void {
    const activeId = this.activeId
    if (!activeId) {
      setActiveOmpClient(null)
      return
    }
    const client = this.ensureClient(activeId)
    setActiveOmpClient(client)
    const state = getRoot(this.states, activeId)
    if (state?.pinned) this.pool.setPin(activeId, true)
  }

  /** Start the active root's runtime through the pool (capacity gate included).
   *  The production boot path reaches the same code through the facade's start
   *  gate; this method exists so tests can drive the controller directly. */
  async startActive(): Promise<boolean> {
    const activeId = this.activeId
    if (!activeId) return false
    if (!(await this.ensureSlotForStart())) return false
    return this.pool.start(activeId)
  }

  /** A restore finished (runtime up, or direct mode accepted): restoring → active. */
  completeActivation(): void {
    const activeId = this.activeId
    if (!activeId) return
    const next = markActive(this.states, activeId, Date.now())
    if (next !== this.states) {
      this.states = next
      this.emit('change')
    }
  }

  /** Ask the pool for a slot before the active root spawns. Returns false when
   *  every slot is held by pinned runtimes (the UI shows the root as queued). */
  private async ensureSlotForStart(): Promise<boolean> {
    const activeId = this.activeId
    if (!activeId) return false
    const entry = this.pool.entry(activeId)
    if (entry?.runtime.running) return true
    while (this.pool.runningCount() >= this.capacity) {
      // Recycle the longest-idle parked root first; pinned roots are never
      // chosen (that is what pin means).
      const candidates = idleReapCandidates(this.states, Date.now(), 0).filter((candidate) => {
        const poolEntry = this.pool.entry(candidate.rootId)
        return poolEntry?.runtime.running === true && poolEntry.leases === 0 && !poolEntry.pinned
      })
      if (candidates.length === 0) return false
      await this.pool.release(candidates[0].rootId).catch(() => undefined)
    }
    return true
  }

  setPinned(rootId: string, pinned: boolean): void {
    this.states = stateSetPinned(this.states, rootId, pinned)
    this.pool.setPin(rootId, pinned)
    this.emit('change')
  }

  /** State-only busy marker (running task/preview/AI on a background root). The
   *  pool itself keys eviction on leases/pin; busy keeps the state machine from
   *  declaring such a root cold. */
  setBusy(rootId: string, busy: boolean): void {
    this.states = stateSetBusy(this.states, rootId, busy)
    this.emit('change')
  }

  snapshot(): RootRuntimeSnapshot {
    const running = this.pool.runningCount()
    const activeRunning = this.activeId !== null && this.pool.entry(this.activeId)?.runtime.running === true
    const queued = this.activeId !== null && !activeRunning && running >= this.capacity
    const roots = this.states.entries.map((entry) => {
      const poolEntry = this.pool.entry(entry.rootId)
      return {
        rootId: entry.rootId,
        status: entry.status,
        pinned: entry.pinned,
        busy: entry.busy,
        running: poolEntry?.runtime.running === true,
        queued: entry.rootId === this.activeId && queued && entry.status === 'restoring'
      }
    })
    return {
      activeRootId: this.activeId,
      capacity: this.capacity,
      running,
      queued,
      roots,
      closedLog: this.states.closedLog
    }
  }

  /** One-shot reap pass (exposed for tests). */
  async idleSweep(): Promise<void> {
    await this.pool.idleSweep()
  }

  /** Process shutdown: stop every per-root runtime and unbind the facade. */
  async shutdown(): Promise<void> {
    this.disposed = true
    await this.pool.stopAll()
    this.clients.clear()
    setActiveOmpClient(null)
  }
}

/** Process-wide controller. Its constructor wires the `ompClient` facade and
 *  the pool start gate, so the app and the workspace service share one story. */
export const rootRuntime = new RootRuntimeController()
