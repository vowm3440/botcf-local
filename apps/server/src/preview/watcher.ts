import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { isDirExcluded, isPathExcluded, WATCH_RULES } from './exclusions.js'
import { watchTree, type WalkWatchHandle } from './walkWatch.js'

/** Debounced recursive workdir watcher feeding the live-preview reload channel.
 *  Change batches are classified so a stylesheet-only edit hot-swaps CSS
 *  instead of reloading the page (which would lose the preview's app state).
 *
 *  Two OS backends sit behind the same batching contract (plan §5):
 *   - `recursive` — one native recursive fs.watch (Windows/macOS). Events from
 *     excluded subtrees still arrive and are filtered in the callback.
 *   - `walk` — Linux: the tree is walked once and excluded subtrees are never
 *     watched, so a `node_modules` install cannot flood the reload channel. */

export type ReloadKind = 'css' | 'reload'

const STYLE_EXTENSIONS = new Set(['.css'])


/** True when a workdir-relative path should not trigger a preview reload. */
export function shouldIgnoreChange(relPath: string): boolean {
  return isPathExcluded(relPath, WATCH_RULES)
}

/** CSS-only batches hot-swap stylesheets; anything else needs a full reload. */
export function classifyChanges(relPaths: readonly string[]): ReloadKind {
  if (relPaths.length === 0) return 'reload'
  return relPaths.every((relPath) => STYLE_EXTENSIONS.has(path.extname(relPath).toLowerCase())) ? 'css' : 'reload'
}

export interface WatchBatch {
  kind: ReloadKind
  paths: string[]
  /** True when more changes arrived than `pendingCap` during one burst: the
   *  path list is intentionally empty and the consumer should do a full rescan
   *  instead of trusting partial paths. */
  rescan: boolean
}

export type WatchStrategy = 'auto' | 'recursive' | 'walk'

export interface WorkdirWatcherOptions {
  /** Coalescing window: editors and formatters emit bursts per save. */
  debounceMs?: number
  /** Upper bound on reported paths per batch; the kind still sees them all. */
  maxPaths?: number
  /** Paths buffered per debounce window; overflow flips the batch to a rescan. */
  pendingCap?: number
  /** Backend selection. `auto` = native recursive on Windows/macOS, the
   *  directory walk on Linux (its fs.watch has no recursive mode). */
  strategy?: WatchStrategy
  /** walk backend only: cap on simultaneously open fs.watch handles. */
  maxWatches?: number
}

/**
 * Emits `change` with a `WatchBatch` after each debounced burst, and `error`
 * with a human-readable string when the OS watcher cannot be established.
 */
export class WorkdirWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null
  private walkHandle: WalkWatchHandle | null = null
  private timer: NodeJS.Timeout | null = null
  private pending = new Set<string>()
  /** Set once pending outgrew pendingCap: stop collecting details, rescan on flush. */
  private rescanPending = false
  private started = false
  private readonly debounceMs: number
  private readonly maxPaths: number
  private readonly pendingCap: number
  private readonly strategy: 'recursive' | 'walk'
  private readonly maxWatches: number | undefined

  constructor(private readonly root: string, options: WorkdirWatcherOptions = {}) {
    super()
    this.debounceMs = options.debounceMs ?? 120
    this.maxPaths = options.maxPaths ?? 50
    this.pendingCap = options.pendingCap ?? 2_000
    this.maxWatches = options.maxWatches
    const requested = options.strategy ?? 'auto'
    this.strategy = requested === 'auto' ? (process.platform === 'linux' ? 'walk' : 'recursive') : requested
  }

  /** Strategy actually in use (test seam + diagnostics). */
  get backend(): 'recursive' | 'walk' {
    return this.strategy
  }

  start(): boolean {
    if (this.started) return true
    try {
      if (this.strategy === 'walk') {
        this.walkHandle = watchTree(
          this.root,
          (relDir) => isDirExcluded(relDir, WATCH_RULES),
          (_event, relPath) => this.handleFsChange(relPath),
          (message) => this.emit('error', message),
          { maxWatches: this.maxWatches }
        )
      } else {
        this.watcher = fs.watch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
          if (typeof filename !== 'string') return
          this.handleFsChange(filename.replace(/\\/g, '/'))
        })
        this.watcher.on('error', (err: unknown) => {
          this.emit('error', err instanceof Error ? err.message : String(err))
        })
      }
      this.started = true
      return true
    } catch (err: unknown) {
      this.watcher?.close()
      this.watcher = null
      this.walkHandle?.stop()
      this.walkHandle = null
      this.started = false
      this.emit('error', `无法监听工作目录: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  private handleFsChange(rel: string): void {
    if (!rel || shouldIgnoreChange(rel)) return
    if (!this.rescanPending) {
      this.pending.add(rel)
      if (this.pending.size > this.pendingCap) {
        // A burst too big to enumerate: drop the detail set, force a rescan.
        this.pending.clear()
        this.rescanPending = true
      }
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const rescan = this.rescanPending
      const paths = rescan ? [] : [...this.pending]
      this.pending.clear()
      this.rescanPending = false
      if (!rescan && paths.length === 0) return
      this.emit(
        'change',
        { kind: rescan ? 'reload' : classifyChanges(paths), paths: paths.slice(0, this.maxPaths), rescan } satisfies WatchBatch
      )
    }, this.debounceMs)
    // A pending reload must never hold the process open on shutdown.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
    this.rescanPending = false
    this.watcher?.close()
    this.watcher = null
    this.walkHandle?.stop()
    this.walkHandle = null
    this.started = false
  }
}
