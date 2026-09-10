import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WatchBatch, WorkdirWatcher, classifyChanges, shouldIgnoreChange } from '../src/preview/watcher.js'

/** Existing coverage stays in preview-watcher.test.ts; here: the pending-cap
 *  overflow that must flip a burst into a full rescan instead of growing the
 *  pending set without bound. */

const temps: string[] = []
let running: WorkdirWatcher | null = null

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-watch-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  running?.stop()
  running = null
})

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

describe('WorkdirWatcher rescan overflow', () => {
  it('reports a rescan batch when a burst exceeds the pending cap', async () => {
    const dir = makeDir()
    const watcher = new WorkdirWatcher(dir, { debounceMs: 40, pendingCap: 2 })
    running = watcher
    const batches: WatchBatch[] = []
    watcher.on('change', (batch: WatchBatch) => batches.push(batch))
    expect(watcher.start()).toBe(true)

    // A synchronous burst of 12 distinct writes cannot be enumerated under a cap
    // of 2: the watcher must collapse it into a single full-reload rescan.
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `f${i}.js`), 'x')

    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0), { timeout: 4_000 })
    const overflow = batches.find((batch) => batch.rescan)
    expect(overflow).toBeDefined()
    expect(overflow!.kind).toBe('reload')
    expect(overflow!.paths).toHaveLength(0)
  })

  it('leaves normal bursts untouched and not flagged as rescan', async () => {
    const dir = makeDir()
    const watcher = new WorkdirWatcher(dir, { debounceMs: 40 })
    running = watcher
    const batches: WatchBatch[] = []
    watcher.on('change', (batch: WatchBatch) => batches.push(batch))
    watcher.start()

    fs.writeFileSync(path.join(dir, 'a.css'), 'body{}')
    fs.writeFileSync(path.join(dir, 'b.css'), 'p{}')
    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0), { timeout: 4_000 })
    expect(batches[0].rescan).toBe(false)
    expect(batches[0].kind).toBe('css')
  })
})
