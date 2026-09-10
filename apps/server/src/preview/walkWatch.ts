import fs from 'node:fs'
import path from 'node:path'

/** Tree-walking watcher backend (Linux branch, plan §5).
 *
 *  Recursive fs.watch (Windows/macOS) reports every change under the root and
 *  the preview filters afterwards. On Linux there is no native recursive watch
 *  worth relying on, so this backend walks the directory tree itself and never
 *  *opens* an excluded subtree at all — a `node_modules` install therefore
 *  cannot flood the reload channel. It exposes a start handle and the same
 *  event/error shape as the recursive path, letting WorkdirWatcher swap
 *  strategies without changing its contract. */

export interface WalkWatchOptions {
  /** Upper bound on simultaneously open fs.watch handles. Over the cap new
   *  subtrees are not watched and one error is surfaced; the already-watched
   *  directories keep reporting. */
  maxWatches?: number
}

export interface WalkWatchHandle {
  stop(): void
}

export function watchTree(
  root: string,
  isDirExcluded: (relDir: string) => boolean,
  onEvent: (event: 'rename' | 'change', relPath: string) => void,
  onError: (message: string) => void,
  options: WalkWatchOptions = {}
): WalkWatchHandle {
  const maxWatches = options.maxWatches ?? 4_000
  const watches = new Map<string, fs.FSWatcher>()
  let closed = false
  let capWarned = false

  const toRel = (abs: string): string => path.relative(root, abs).replace(/\\/g, '/')

  function removeWatch(absDir: string): void {
    const existing = watches.get(absDir)
    if (!existing) return
    watches.delete(absDir)
    try {
      existing.close()
    } catch {
      // Already closed by the OS after the directory disappeared.
    }
  }

  function addWatcher(absDir: string): void {
    if (closed || watches.has(absDir)) return
    if (watches.size >= maxWatches) {
      if (!capWarned) {
        capWarned = true
        onError(`目录监听数超过上限 ${maxWatches},深层子目录不再逐个监听`)
      }
      return
    }
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(absDir, { persistent: false }, (event, filename) => {
        if (closed || typeof filename !== 'string' || filename.length === 0) return
        const abs = path.join(absDir, filename)
        const rel = toRel(abs)
        let exists = false
        let isDir = false
        try {
          const stat = fs.statSync(abs)
          exists = true
          isDir = stat.isDirectory()
        } catch {
          // Renamed/removed between the event and the stat.
        }
        // Directory attribute noise: writing a file bumps the containing
        // directories' mtime, which Windows reports as a `change` on each
        // ancestor watch. Only file events and real directory add/remove
        // should reach the reload channel.
        if (isDir && event === 'change') return
        if (event === 'rename') {
          if (isDir) {
            // A new directory may contain deeper directories no existing watch
            // covers (`mkdir -p a/b/c` only reports `a` in the parent watch).
            if (!isDirExcluded(rel)) scanDir(abs)
            onEvent('rename', rel)
          } else {
            // File changed through a temp+rename, or a watched directory
            // disappeared: drop a removed directory's own watch so churn
            // cannot leak handles.
            if (!exists) removeWatch(abs)
            onEvent('rename', rel)
          }
          return
        }
        onEvent('change', rel)
      })
    } catch (err) {
      onError(`无法监听目录 ${absDir}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // A watched directory disappearing surfaces as an error on some platforms;
    // the parent's rename handler drops the entry, so this only self-heals.
    watcher.on('error', () => removeWatch(absDir))
    watches.set(absDir, watcher)
  }

  function scanDir(absDir: string): void {
    if (closed) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return // Directory vanished mid-walk.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const childAbs = path.join(absDir, entry.name)
      if (isDirExcluded(toRel(childAbs))) continue
      addWatcher(childAbs)
      scanDir(childAbs)
    }
  }

  addWatcher(root)
  scanDir(root)

  return {
    stop(): void {
      closed = true
      for (const watcher of watches.values()) {
        try {
          watcher.close()
        } catch {
          // Already closed.
        }
      }
      watches.clear()
    }
  }
}
