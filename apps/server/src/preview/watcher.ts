import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import path from 'node:path'

/** Debounced recursive workdir watcher feeding the live-preview reload channel.
 *  Change batches are classified so a stylesheet-only edit hot-swaps CSS
 *  instead of reloading the page (which would lose the preview's app state). */

/** Directories that never belong in a preview reload batch. Build outputs are
 *  included: a dev server rewriting dist/ on every save would loop forever. */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.vite',
  '.idea',
  '.vscode',
  '__pycache__',
  'target',
  'data'
])

/** Editor scratch files: swap files, atomic-save temporaries, lockfiles. */
const IGNORED_FILE = /(^\.#|~$|\.swp$|\.swx$|\.tmp$|\.crswap$|^4913$|\.DS_Store$)/i

const STYLE_EXTENSIONS = new Set(['.css'])

export type ReloadKind = 'css' | 'reload'

/** True when a workdir-relative path should not trigger a preview reload. */
export function shouldIgnoreChange(relPath: string): boolean {
  if (!relPath) return true
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return true
  if (parts.some((part) => IGNORED_SEGMENTS.has(part))) return true
  return IGNORED_FILE.test(parts[parts.length - 1])
}

/** CSS-only batches hot-swap stylesheets; anything else needs a full reload. */
export function classifyChanges(relPaths: readonly string[]): ReloadKind {
  if (relPaths.length === 0) return 'reload'
  return relPaths.every((relPath) => STYLE_EXTENSIONS.has(path.extname(relPath).toLowerCase())) ? 'css' : 'reload'
}

export interface WatchBatch {
  kind: ReloadKind
  paths: string[]
}

export interface WorkdirWatcherOptions {
  /** Coalescing window: editors and formatters emit bursts per save. */
  debounceMs?: number
  /** Upper bound on reported paths per batch; the kind still sees them all. */
  maxPaths?: number
}

/**
 * Emits `change` with a `WatchBatch` after each debounced burst, and `error`
 * with a human-readable string when the OS watcher cannot be established.
 */
export class WorkdirWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private pending = new Set<string>()
  private readonly debounceMs: number
  private readonly maxPaths: number

  constructor(private readonly root: string, options: WorkdirWatcherOptions = {}) {
    super()
    this.debounceMs = options.debounceMs ?? 120
    this.maxPaths = options.maxPaths ?? 50
  }

  start(): boolean {
    if (this.watcher) return true
    try {
      this.watcher = fs.watch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return
        const rel = String(filename).replace(/\\/g, '/')
        if (shouldIgnoreChange(rel)) return
        this.pending.add(rel)
        this.schedule()
      })
      this.watcher.on('error', (err: unknown) => {
        this.emit('error', err instanceof Error ? err.message : String(err))
      })
      return true
    } catch (err: unknown) {
      this.watcher = null
      this.emit('error', `无法监听工作目录: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const paths = [...this.pending]
      this.pending.clear()
      if (paths.length === 0) return
      this.emit('change', { kind: classifyChanges(paths), paths: paths.slice(0, this.maxPaths) } satisfies WatchBatch)
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
    this.watcher?.close()
    this.watcher = null
  }
}
