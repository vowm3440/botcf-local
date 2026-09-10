import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_RUN_HISTORY, TaskManager } from '../src/tasks/manager.js'
import { transcriptFile } from '../src/logs/transcripts.js'
import type { TaskDefinition } from '../src/tasks/model.js'
import type { TaskRunInfo } from '../src/tasks/runner.js'

/** Manager-level scheduling tests: heavy (build/test) work must serialize, while
 *  ordinary tasks still share the pool four-at-a-time. Real children (node -e
 *  would fight Windows shell quoting, so short .cjs scripts instead). */

const temps: string[] = []
const managers: TaskManager[] = []

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-tasks-'))
  temps.push(dir)
  return dir
}

function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

function task(file: string, id: string, name: string, kind: TaskDefinition['kind']): TaskDefinition {
  return {
    id,
    name,
    kind,
    source: 'config',
    file: 'node',
    args: [file],
    commandLine: `node ${file}`,
    cwd: '',
    env: {},
    background: false
  }
}

function newManager(): TaskManager {
  const manager = new TaskManager()
  managers.push(manager)
  return manager
}

afterEach(async () => {
  await Promise.allSettled(managers.map((manager) => manager.stopAll()))
  managers.length = 0
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
  temps.length = 0
})

describe('TaskManager heavy-task serial queue', () => {
  it('queues a second build behind the first and runs them strictly serially', async () => {
    const dir = makeRoot()
    const slowBuild = writeScript(dir, 'slow.cjs', 'setTimeout(() => process.exit(0), 150)')
    const manager = newManager()

    const first = manager.start({ task: task(slowBuild, 'build:first', 'build-first', 'build'), rootId: 'r1', rootName: 'app', rootPath: dir })
    const second = manager.start({ task: task(slowBuild, 'build:second', 'build-second', 'build'), rootId: 'r1', rootName: 'app', rootPath: dir })
    if (!first.ok || !second.ok) throw new Error('both heavy starts should be accepted')

    // The first build holds the pool; the second waits in the queue.
    expect(first.run.info().state).toBe('running')
    expect(second.run.info().state).toBe('queued')
    expect(manager.list().filter((run) => run.state === 'running')).toHaveLength(1)

    const firstEnd = new Promise<TaskRunInfo>((resolve) => manager.once('end', resolve))
    await firstEnd
    // The queue drains the moment the slot frees.
    await vi.waitFor(() => expect(second.run.info().state).toBe('running'), { timeout: 2_000 })
    const secondEnd = new Promise<TaskRunInfo>((resolve) => manager.once('end', resolve))
    const ended = await secondEnd
    expect(ended.state).toBe('succeeded')
    expect(manager.list().filter((run) => run.state === 'running' || run.state === 'queued')).toHaveLength(0)
  })

  it('refuses an ordinary task while heavy work holds the pool, then runs it after', async () => {
    const root = makeRoot()
    const dir = root
    const script = writeScript(dir, 'sleep.cjs', 'setTimeout(() => process.exit(0), 120)')
    const manager = newManager()

    const heavy = manager.start({ task: task(script, 'build:only', 'build', 'build'), rootId: 'r1', rootName: 'app', rootPath: dir })
    if (!heavy.ok) throw new Error('heavy start should be accepted')
    expect(heavy.run.info().state).toBe('running')

    // A heavy build takes the whole pool: ordinary work must not overlap it.
    const normal = manager.start({ task: task(script, 'custom:only', 'custom', 'custom'), rootId: 'r1', rootName: 'app', rootPath: dir })
    expect(normal.ok).toBe(false)
    if (normal.ok) throw new Error('unreachable')
    expect(normal.status).toBe(409)

    const ended = new Promise<TaskRunInfo>((resolve) => manager.once('end', resolve))
    expect((await ended).taskId).toBe('build:only')

    const retry = manager.start({ task: task(script, 'custom:only', 'custom', 'custom'), rootId: 'r1', rootName: 'app', rootPath: dir })
    if (!retry.ok) throw new Error('retry should be accepted after heavy work ends')
    expect(retry.run.info().state).toBe('running')
  })

  it('keeps four ordinary tasks running in parallel and refuses a fifth', async () => {
    const root = makeRoot()
    const script = writeScript(root, 'sleep.cjs', 'setTimeout(() => process.exit(0), 200)')
    const manager = newManager()

    const started: string[] = []
    for (let i = 0; i < 4; i++) {
      const result = manager.start({ task: task(script, `custom:${i}`, `job-${i}`, 'custom'), rootId: 'r1', rootName: 'app', rootPath: root })
      if (!result.ok) throw new Error(`start ${i} failed`)
      started.push(result.run.id)
    }
    expect(manager.list().filter((run) => run.state === 'running')).toHaveLength(4)

    const fifth = manager.start({ task: task(script, 'custom:extra', 'job-extra', 'custom'), rootId: 'r1', rootName: 'app', rootPath: root })
    expect(fifth.ok).toBe(false)
    if (fifth.ok) throw new Error('unreachable')
    expect(fifth.status).toBe(409)
  })

  it('stops a queued build without ever spawning it', async () => {
    const root = makeRoot()
    const script = writeScript(root, 'long.cjs', 'setTimeout(() => process.exit(0), 400)')
    const manager = newManager()

    const first = manager.start({ task: task(script, 'build:hold', 'hold', 'build'), rootId: 'r1', rootName: 'app', rootPath: root })
    const queued = manager.start({ task: task(script, 'build:cancel', 'cancel', 'build'), rootId: 'r1', rootName: 'app', rootPath: root })
    if (!first.ok || !queued.ok) throw new Error('both starts should be accepted')
    expect(queued.run.info().state).toBe('queued')

    const stopped = await manager.stop(queued.run.id)
    expect(stopped).toBe(true)
    expect(queued.run.info().state).toBe('stopped')
    expect(queued.run.snapshot()).toHaveLength(0)
  })
})

describe('TaskManager full-log transcripts', () => {
  function newManagerWithDir(dataDir: string): TaskManager {
    const manager = new TaskManager(undefined, dataDir)
    managers.push(manager)
    return manager
  }

  it('writes the run transcript to disk and removes it on clearHistory', async () => {
    const dataDir = makeRoot()
    const root = path.join(dataDir, 'proj')
    fs.mkdirSync(root)
    const script = writeScript(root, 'hello.cjs', "console.log('hello from run')")
    const manager = newManagerWithDir(dataDir)

    const started = manager.start({ task: task(script, 'custom:hello', 'hello', 'custom'), rootId: 'r1', rootName: 'app', rootPath: root })
    if (!started.ok) throw new Error('start should be accepted')
    const run = started.run
    const file = transcriptFile(dataDir, 'tasks', 'r1', run.id)
    const ended = new Promise<TaskRunInfo>((resolve) => manager.once('end', resolve))
    await ended
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('hello from run')

    expect(manager.clearHistory()).toBeGreaterThan(0)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('prunes transcript files of the oldest finished runs', async () => {
    const dataDir = makeRoot()
    const root = path.join(dataDir, 'proj')
    fs.mkdirSync(root)
    const script = writeScript(root, 'quick.cjs', 'process.exit(0)')
    const manager = newManagerWithDir(dataDir)
    const files: string[] = []
    const ended = (): Promise<TaskRunInfo> =>
      new Promise<TaskRunInfo>((resolve) => manager.once('end', resolve))

    for (let i = 0; i < MAX_RUN_HISTORY; i++) {
      const started = manager.start({ task: task(script, `custom:${i}`, `job-${i}`, 'custom'), rootId: 'r1', rootName: 'app', rootPath: root })
      if (!started.ok) throw new Error('start should be accepted')
      files.push(transcriptFile(dataDir, 'tasks', 'r1', started.run.id))
      await ended()
    }
    // Two more starts push the finished history past MAX_RUN_HISTORY: the
    // second one prunes the oldest run and its transcript file.
    for (let i = 0; i < 2; i++) {
      const started = manager.start({ task: task(script, `custom:extra${i}`, `extra-${i}`, 'custom'), rootId: 'r1', rootName: 'app', rootPath: root })
      if (!started.ok) throw new Error('start should be accepted')
      files.push(transcriptFile(dataDir, 'tasks', 'r1', started.run.id))
      await ended()
    }
    expect(manager.list().length).toBeLessThanOrEqual(MAX_RUN_HISTORY)
    expect(fs.existsSync(files[0])).toBe(false)
    expect(fs.existsSync(files[files.length - 1])).toBe(true)
  })
})
