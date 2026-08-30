import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WatchBatch, WorkdirWatcher, classifyChanges, shouldIgnoreChange } from '../src/preview/watcher.js'

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

describe('shouldIgnoreChange', () => {
  it('ignores dependency, VCS and build directories at any depth', () => {
    expect(shouldIgnoreChange('node_modules/react/index.js')).toBe(true)
    expect(shouldIgnoreChange('packages/ui/node_modules/x.js')).toBe(true)
    expect(shouldIgnoreChange('.git/HEAD')).toBe(true)
    expect(shouldIgnoreChange('dist/app.js')).toBe(true)
    expect(shouldIgnoreChange('apps/web/dist/index.html')).toBe(true)
    expect(shouldIgnoreChange('.next/server/page.js')).toBe(true)
    expect(shouldIgnoreChange('data/botcf.db')).toBe(true)
  })

  it('ignores editor scratch files', () => {
    expect(shouldIgnoreChange('src/.#App.tsx')).toBe(true)
    expect(shouldIgnoreChange('src/App.tsx~')).toBe(true)
    expect(shouldIgnoreChange('src/.App.tsx.swp')).toBe(true)
    expect(shouldIgnoreChange('src/App.tsx.tmp')).toBe(true)
  })

  it('ignores an empty path', () => {
    expect(shouldIgnoreChange('')).toBe(true)
  })

  it('keeps ordinary source files', () => {
    expect(shouldIgnoreChange('src/App.tsx')).toBe(false)
    expect(shouldIgnoreChange('index.html')).toBe(false)
    expect(shouldIgnoreChange('styles/site.css')).toBe(false)
  })
})

describe('classifyChanges', () => {
  it('hot-swaps css-only batches', () => {
    expect(classifyChanges(['a.css', 'theme/b.CSS'])).toBe('css')
  })

  it('reloads when anything else changed', () => {
    expect(classifyChanges(['a.css', 'main.js'])).toBe('reload')
    expect(classifyChanges(['index.html'])).toBe('reload')
    expect(classifyChanges([])).toBe('reload')
  })
})

describe('WorkdirWatcher', () => {
  it('coalesces a burst of writes into one classified batch', async () => {
    const dir = makeDir()
    const watcher = new WorkdirWatcher(dir, { debounceMs: 40 })
    running = watcher
    const batches: WatchBatch[] = []
    watcher.on('change', (batch: WatchBatch) => batches.push(batch))
    expect(watcher.start()).toBe(true)

    fs.writeFileSync(path.join(dir, 'a.css'), 'body{}')
    fs.writeFileSync(path.join(dir, 'b.css'), 'p{}')

    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0), { timeout: 4_000 })
    expect(batches[0].kind).toBe('css')
    expect(batches[0].paths.some((rel) => rel.endsWith('.css'))).toBe(true)
  })

  it('never reports ignored directories', async () => {
    const dir = makeDir()
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    const watcher = new WorkdirWatcher(dir, { debounceMs: 30 })
    running = watcher
    const batches: WatchBatch[] = []
    watcher.on('change', (batch: WatchBatch) => batches.push(batch))
    watcher.start()

    fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 250))
    fs.writeFileSync(path.join(dir, 'main.js'), 'y')

    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0), { timeout: 4_000 })
    expect(batches.flatMap((batch) => batch.paths).every((rel) => !rel.includes('node_modules'))).toBe(true)
  })

  it('stops cleanly and drops pending batches', async () => {
    const dir = makeDir()
    const watcher = new WorkdirWatcher(dir, { debounceMs: 1_000 })
    running = watcher
    const batches: WatchBatch[] = []
    watcher.on('change', (batch: WatchBatch) => batches.push(batch))
    watcher.start()
    fs.writeFileSync(path.join(dir, 'a.js'), 'x')
    watcher.stop()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(batches).toHaveLength(0)
  })
})
