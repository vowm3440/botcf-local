import os from 'node:os'

/** Dynamic degradation (plan §4): the server samples available memory every ten
 *  seconds; below 15% it temporarily drops parallel-AI capacity to 1 and pauses
 *  reload watchers of non-active roots, restoring both once memory recovers
 *  above 20% (a 5% hysteresis band stops the loop from flapping).
 *
 *  Everything the loop touches is injected, so the decision logic is a plain
 *  unit test: the sampler is fake memory, the timers are manual, and the actions
 *  are recorded calls. */

export interface MemorySample {
  /** os.freemem()/os.totalmem() ratio, 0..1. */
  availableRatio: number
  /** This process's resident set, for the observability log line. */
  selfRssBytes: number
}

export type MemorySampler = () => MemorySample

export interface DegradeActions {
  /** Current parallel-AI capacity (pool). */
  capacity(): number
  /** Raise/lower the capacity; lowering evicts background runtimes. */
  setCapacity(next: number): Promise<void> | void
  /** Stop reload watchers that belong to non-active roots (idempotent). */
  pauseBackgroundWatchers(): void
  /** Restart them after the pressure passes (idempotent). */
  resumeBackgroundWatchers(): void
}

export interface DegradeTimers {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

export interface DegraderOptions {
  actions: DegradeActions
  /** Defaults to real OS memory. Tests pass a fixed sequence. */
  sample?: MemorySampler
  intervalMs?: number
  /** Enter degradation below this available-memory ratio. */
  degradeBelow?: number
  /** Leave degradation above this available-memory ratio. */
  restoreAbove?: number
  timers?: DegradeTimers
}

export const DEFAULT_DEGRADE_INTERVAL_MS = 10_000
export const DEFAULT_DEGRADE_BELOW = 0.15
export const DEFAULT_RESTORE_ABOVE = 0.2

export function sampleSystemMemory(): MemorySample {
  return { availableRatio: os.freemem() / os.totalmem(), selfRssBytes: process.memoryUsage().rss }
}

export type DegradePhase = 'normal' | 'degraded'

export class ResourceDegrader {
  private readonly actions: DegradeActions
  private readonly sample: MemorySampler
  private readonly intervalMs: number
  private readonly degradeBelow: number
  private readonly restoreAbove: number
  private readonly timers: DegradeTimers
  private phase: DegradePhase = 'normal'
  /** Pool capacity observed when pressure hit; the restore goes back to it. */
  private normalCapacity = 0
  private timer: unknown = null

  constructor(options: DegraderOptions) {
    this.actions = options.actions
    this.sample = options.sample ?? sampleSystemMemory
    this.intervalMs = options.intervalMs ?? DEFAULT_DEGRADE_INTERVAL_MS
    this.degradeBelow = options.degradeBelow ?? DEFAULT_DEGRADE_BELOW
    this.restoreAbove = options.restoreAbove ?? DEFAULT_RESTORE_ABOVE
    this.timers = options.timers ?? { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout) }
  }

  get state(): DegradePhase {
    return this.phase
  }

  /** Arm the ten-second sampling loop. */
  start(): void {
    if (this.timer !== null) return
    this.schedule()
  }

  stop(): void {
    if (this.timer === null) return
    this.timers.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      void this.tick().catch(() => undefined)
      this.schedule()
    }, this.intervalMs)
  }

  /** One sample + one decision. Exposed so tests can drive the loop directly. */
  async tick(): Promise<void> {
    const { availableRatio } = this.sample()
    if (this.phase === 'normal' && availableRatio < this.degradeBelow) {
      this.normalCapacity = this.actions.capacity()
      this.phase = 'degraded'
      await this.actions.setCapacity(1)
      this.actions.pauseBackgroundWatchers()
    } else if (this.phase === 'degraded' && availableRatio > this.restoreAbove) {
      this.phase = 'normal'
      await this.actions.setCapacity(Math.max(1, this.normalCapacity))
      this.actions.resumeBackgroundWatchers()
    }
  }
}
