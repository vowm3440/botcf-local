/** Byte-bounded LRU for read-only document snapshots (plan §4 budget row:
 *  non-active document cache 64 MiB, evict the oldest read-only document first).
 *
 *  The editor keeps only the front tab mounted, so most open files have no live
 *  buffer at all. Clean content is cheap to re-fetch, but a bounded snapshot
 *  cache makes switching back to a recently read file instant and — this is the
 *  point of the budget — guarantees the bytes retained for *unmounted* documents
 *  stay flat no matter how many tabs or files exist. Dirty buffers live in
 *  draftStore; this module is the spill target when a draft is evicted, and the
 *  clean-snapshot cache for read-only views.
 *
 *  Every snapshot carries the disk mtime it was read at; a caller that knows the
 *  file changed simply does not ask for the old snapshot. The cache itself never
 *  reaches the disk and never refreshes anything. */

export interface DocSnapshot {
  /** Monotonic last-use counter, bumped on read and on write. */
  seq: number
  /** Disk mtime the snapshot was read at; used for stale-detection. */
  mtimeMs: number
  content: string
}

export interface DocCacheStats {
  /** UTF-8 bytes currently retained (buffer.byteLength). */
  bytes: number
  entries: number
  /** Budget the cache was constructed with. */
  budgetBytes: number
}

/** Default budget: 64 MiB across all non-active documents. */
export const DEFAULT_DOC_CACHE_BYTES = 64 * 1024 * 1024

/** Pure eviction decision: given entries in last-use order (oldest first),
 *  return the keys to drop so total bytes fit the budget. Exported so tests can
 *  drive it without constructing the module cache. */
export function evictToBudget(
  entries: ReadonlyArray<{ key: string; bytes: number }>,
  budgetBytes: number
): string[] {
  let total = 0
  for (const entry of entries) total += entry.bytes
  const victims: string[] = []
  for (const entry of entries) {
    if (total <= budgetBytes) break
    victims.push(entry.key)
    total -= entry.bytes
  }
  return victims
}

const utf8Encoder = new TextEncoder()

function utf8Bytes(content: string): number {
  return utf8Encoder.encode(content).length
}

export class DocCache {
  private readonly budgetBytes: number
  /** key → snapshot, insertion order is unused; seq drives LRU. */
  private readonly snapshots = new Map<string, DocSnapshot>()
  private nextSeq = 1
  private bytesRetained = 0

  constructor(budgetBytes: number = DEFAULT_DOC_CACHE_BYTES) {
    this.budgetBytes = budgetBytes
  }

  private touch(key: string): DocSnapshot | null {
    const snapshot = this.snapshots.get(key)
    if (!snapshot) return null
    snapshot.seq = this.nextSeq++
    return snapshot
  }

  /** Snapshot for a key when its mtime still matches; otherwise null. Reading
   *  bumps recency. */
  peek(key: string, mtimeMs?: number): DocSnapshot | null {
    const snapshot = this.touch(key)
    if (!snapshot) return null
    if (mtimeMs !== undefined && snapshot.mtimeMs !== mtimeMs) return null
    return { ...snapshot }
  }

  /** Read content bytes without bumping recency (used by stats/tests). */
  has(key: string): boolean {
    return this.snapshots.has(key)
  }

  /** Store (or refresh) a snapshot. Over-budget entries are evicted oldest-first
   *  — a single document larger than the whole budget is dropped immediately. */
  set(key: string, mtimeMs: number, content: string): void {
    const existing = this.snapshots.get(key)
    const incomingBytes = utf8Bytes(content)
    if (existing) this.bytesRetained -= utf8Bytes(existing.content)

    if (incomingBytes > this.budgetBytes) {
      this.snapshots.delete(key)
      this.bytesRetained = Math.max(0, this.bytesRetained)
      return
    }

    const snapshot: DocSnapshot = { seq: this.nextSeq++, mtimeMs, content }
    this.snapshots.set(key, snapshot)
    this.bytesRetained += incomingBytes
    this.evictIfNeeded()
  }

  private evictIfNeeded(): void {
    const ordered = [...this.snapshots.entries()]
      .map(([key, snapshot]) => ({ key, bytes: utf8Bytes(snapshot.content), seq: snapshot.seq }))
      .sort((a, b) => a.seq - b.seq)
    for (const key of evictToBudget(ordered, this.budgetBytes)) {
      const snapshot = this.snapshots.get(key)
      if (!snapshot) continue
      this.snapshots.delete(key)
      this.bytesRetained -= utf8Bytes(snapshot.content)
    }
  }

  delete(key: string): void {
    const snapshot = this.snapshots.get(key)
    if (!snapshot) return
    this.snapshots.delete(key)
    this.bytesRetained -= utf8Bytes(snapshot.content)
  }

  clear(): void {
    this.snapshots.clear()
    this.bytesRetained = 0
  }

  stats(): DocCacheStats {
    return { bytes: this.bytesRetained, entries: this.snapshots.size, budgetBytes: this.budgetBytes }
  }
}
