import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { READ_RULES, SEARCH_RULES, WATCH_RULES, isDirExcluded, isPathExcluded } from '../src/preview/exclusions.js'
import { WatchBatch, WorkdirWatcher } from '../src/preview/watcher.js'

const temps: string[] = []
let running: WorkdirWatcher | null = null

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-walk-'))
  temps.push(dir)
  return dir
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  running?.stop()
  running = null
})

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

/** Exclusion rules are three separate configurations (plan §5): the preview
 *  watcher skips build output and dependency trees, a search keeps build output
 *  searchable, and the file tree/read side excludes nothing. */
describe('exclusion rules are split per activity', () => {
  it('watch ignores dependencies, VCS and build output at any depth', () => {
    expect(isPathExcluded('node_modules/react/index.js', WATCH_RULES)).toBe(true)
    expect(isPathExcluded('pkg/node_modules/x.js', WATCH_RULES)).toBe(true)
    expect(isPathExcluded('.git/HEAD', WATCH_RULES)).toBe(true)
    expect(isPathExcluded('apps/web/dist/index.html', WATCH_RULES)).toBe(true)
    expect(isPathExcluded('.next/server/page.js', WATCH_RULES)).toBe(true)
    expect(isPathExcluded('src/.#App.tsx', WATCH_RULES)).toBe(true)
    expect(isPathExcluded('src/App.tsx', WATCH_RULES)).toBe(false)
  })

  it('search keeps build output searchable but still skips noise', () => {
    expect(isPathExcluded('pkg/dist/app.js', SEARCH_RULES)).toBe(false)
    expect(isPathExcluded('node_modules/x/index.js', SEARCH_RULES)).toBe(true)
    expect(isPathExcluded('.git/HEAD', SEARCH_RULES)).toBe(true)
  })

  it('read excludes nothing: the user decides what to open', () => {
    expect(isPathExcluded('node_modules/react/index.js', READ_RULES)).toBe(false)
    expect(isPathExcluded('dist/app.js', READ_RULES)).toBe(false)
    expect(isPathExcluded('src/.#App.tsx', READ_RULES)).toBe(false)
  })

  it('directory checks use the same per-activity sets', () => {
    expect(isDirExcluded('pkg/node_modules', WATCH_RULES)).toBe(true)
    expect(isDirExcluded('dist', WATCH_RULES)).toBe(true)
    expect(isDirExcluded('dist', SEARCH_RULES)).toBe(false)
    expect(isDirExcluded('node_modules', READ_RULES)).toBe(false)
    expect(isDirExcluded('src/deep', WATCH_RULES)).toBe(false)
  })
})

/** The walk backend is what Linux uses (its fs.watch has no native recursive
 *  mode). It must behave like the recursive path for live reloads — same batching,
 *  same classification — while never *opening* an excluded subtree at all. */
describe('WorkdirWatcher walk backend (strategy: walk)', () => {
  it('watches a pre-existing nested directory and reports edits', async () => {
    const dir = makeDir()
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'deep', 'app.css'), 'body{}')
    const watcher = new WorkdirWatcher(dir, { debounceMs: 40, strategy: 'walk' })
    running = watcher
    expect(watcher.backend).toBe('walk')
    const batches: WatchBatch[] = []
    watcher.on('change', (batch: WatchBatch) => batches.push(batch))
    expect(watcher.start()).toBe(true)

    fs.writeFileSync(path.join(dir, 'src', 'deep', 'app.css'), 'body{color:red}')
    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0), { timeout: 4_000 })
    expect(batches[0].kind).toBe('css')
    expect(batches.flatMap((batch) => batch.paths)).toContain('src/deep/app.css')
  })

  it('never watches an excluded subtree, and stays live for the rest', async () => {
    const dir = makeDir()
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true })
    const watcher = new WorkdirWatcher(dir, { debounceMs: 30, strategy: 'walk' })
    running = watcher
    const batches: WatchBatch[] = []
    watcher.on('change', (batch: WatchBatch) => batches.push(batch))
    watcher.start()

    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x')
    await sleep(250)
    expect(batches).toHaveLength(0)
    fs.writeFileSync(path.join(dir, 'main.css'), 'y')
    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0), { timeout: 4_000 })
    expect(batches.flatMap((batch) => batch.paths).every((rel) => !rel.includes('node_modules'))).toBe(true)
  })

  it('discovers directories created after start and reports files inside them', async () => {
    const dir = makeDir()
    const watcher = new WorkdirWatcher(dir, { debounceMs: 40, strategy: 'walk' })
    running = watcher
    const batches: WatchBatch[] = []
    watcher.on('change', (batch: WatchBatch) => batches.push(batch))
    watcher.start()

    fs.mkdirSync(path.join(dir, 'packages', 'a', 'b'), { recursive: true })
    // Let the OS rename events land and the walker open the new directories.
    await sleep(300)
    fs.writeFileSync(path.join(dir, 'packages', 'a', 'b', 'c.css'), 'body{}')
    await vi.waitFor(() => expect(batches.flatMap((batch) => batch.paths)).toContain('packages/a/b/c.css'), {
      timeout: 4_000
    })
  })

  it('surfaces an error once the directory-watch cap is hit', async () => {
    const dir = makeDir()
    fs.mkdirSync(path.join(dir, 'one'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'two'), { recursive: true })
    const watcher = new WorkdirWatcher(dir, { strategy: 'walk', maxWatches: 1, debounceMs: 40 })
    running = watcher
    const errors: string[] = []
    watcher.on('error', (message: string) => errors.push(message))
    watcher.start()
    await vi.waitFor(() => expect(errors.some((message) => message.includes('上限'))).toBe(true), { timeout: 2_000 })
  })
})

describe('WorkdirWatcher strategy selection', () => {
  it('auto picks the native recursive backend everywhere but Linux', () => {
    const watcher = new WorkdirWatcher(makeDir())
    running = watcher
    expect(watcher.backend).toBe(process.platform === 'linux' ? 'walk' : 'recursive')
  })

  it('keeps the recursive backend explicit on any platform', () => {
    const watcher = new WorkdirWatcher(makeDir(), { strategy: 'recursive' })
    running = watcher
    expect(watcher.backend).toBe('recursive')
  })
})
