import { describe, expect, it } from 'vitest'
import { DocCache, evictToBudget, DEFAULT_DOC_CACHE_BYTES } from '../src/editor/docCache'

const chunk = (size: number, fill = 'x'): string => fill.repeat(size)

describe('docCache byte-bounded LRU', () => {
  it('caches and returns snapshots, bumping recency on read', () => {
    const cache = new DocCache(1024)
    cache.set('a.md', 100, 'hello')
    const first = cache.peek('a.md', 100)
    expect(first?.content).toBe('hello')
    expect(first?.mtimeMs).toBe(100)
    // mtime mismatch ⇒ treated as stale.
    expect(cache.peek('a.md', 999)).toBeNull()
  })

  it('evicts the oldest-*used* entry when the byte budget is exceeded', () => {
    const cache = new DocCache(100)
    cache.set('old', 1, chunk(60))
    cache.set('newer', 2, chunk(50))
    // new entry pushed total over budget: 'old' (least recently used) goes.
    expect(cache.has('old')).toBe(false)
    expect(cache.has('newer')).toBe(true)
    expect(cache.stats().bytes).toBeLessThanOrEqual(100)
  })

  it('reads bump recency so a recently-read entry survives eviction', () => {
    const cache = new DocCache(120)
    cache.set('a', 1, chunk(60))
    cache.set('b', 2, chunk(40))
    cache.peek('a')
    cache.set('c', 3, chunk(50))
    // Dropping b (40 B) is enough to fit 120 B, so the recently-read a survives.
    expect(cache.has('b')).toBe(false)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('c')).toBe(true)
  })

  it('drops a single document larger than the whole budget', () => {
    const cache = new DocCache(64)
    cache.set('huge', 1, chunk(128))
    expect(cache.has('huge')).toBe(false)
    expect(cache.stats().bytes).toBe(0)
  })

  it('updates bytes when a key is overwritten', () => {
    const cache = new DocCache(1000)
    cache.set('a', 1, chunk(100))
    cache.set('a', 2, chunk(300))
    expect(cache.stats()).toMatchObject({ bytes: 300, entries: 1 })
    cache.delete('a')
    expect(cache.stats().bytes).toBe(0)
  })

  it('retained bytes stay flat no matter how many documents are added (acceptance)', () => {
    const budget = 64 * 1024
    const cache = new DocCache(budget)
    for (let i = 0; i < 2000; i++) {
      cache.set(`file-${i}.txt`, i, chunk(256))
      expect(cache.stats().bytes).toBeLessThanOrEqual(budget)
    }
    expect(cache.stats().entries).toBeLessThan(1000)
    expect(DEFAULT_DOC_CACHE_BYTES).toBe(64 * 1024 * 1024)
  })
})

describe('evictToBudget', () => {
  it('is pure: oldest-first until bytes fit', () => {
    const victims = evictToBudget(
      [
        { key: 'a', bytes: 40 },
        { key: 'b', bytes: 40 },
        { key: 'c', bytes: 40 }
      ],
      70
    )
    expect(victims).toEqual(['a', 'b'])
  })

  it('keeps everything under or at the budget', () => {
    expect(evictToBudget([{ key: 'a', bytes: 40 }], 40)).toEqual([])
  })
})
