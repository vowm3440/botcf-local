import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { TaskRun, type TaskLogLine, type TaskRunInfo, type TaskRunOptions } from '../src/tasks/runner.js'

/** The runner is the shared mechanism behind build / run / test, so what matters
 *  is the verdict it reports and that no output is lost — including a final line
 *  that never got its newline. */

/** Literal ESC, built rather than typed so the source stays readable. */
const ESC = String.fromCharCode(27)

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
  pid = 4242
  kill = vi.fn(() => true)
}

function makeRun(child: FakeChild, overrides: Partial<TaskRunOptions> = {}) {
  const spawnProcess = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn
  const run = new TaskRun({
    id: 'run1',
    taskId: 'script:build',
    taskName: 'build',
    rootId: 'r1',
    rootName: 'app',
    file: 'npm',
    args: ['run', 'build'],
    cwd: '/tmp/app',
    background: false,
    commandLine: 'npm run build',
    spawnProcess,
    ...overrides
  })
  return { run, spawnProcess }
}

describe('TaskRun', () => {
  it('captures output, then reports success', async () => {
    const child = new FakeChild()
    const { run, spawnProcess } = makeRun(child)
    const lines: TaskLogLine[] = []
    run.on('line', (line: TaskLogLine) => lines.push(line))
    const ended = new Promise<TaskRunInfo>((resolve) => run.once('end', resolve))

    run.start()
    child.stdout.write('> tsc -p .\n')
    child.stderr.write('warning: slow\n')
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(3))
    child.emit('exit', 0, null)
    const info = await ended

    expect(info).toMatchObject({ state: 'succeeded', exitCode: 0, taskName: 'build' })
    expect(info.durationMs).toBeGreaterThanOrEqual(0)
    // The command line is echoed first, so a log always says what ran.
    expect(lines[0]).toMatchObject({ stream: 'system' })
    expect(lines[0].text).toContain('npm run build')
    expect(lines.some((line) => line.stream === 'stdout' && line.text === '> tsc -p .')).toBe(true)
    expect(lines.some((line) => line.stream === 'stderr' && line.text === 'warning: slow')).toBe(true)
    expect(spawnProcess).toHaveBeenCalledOnce()
  })

  it('reports a non-zero exit as failure', async () => {
    const child = new FakeChild()
    const { run } = makeRun(child)
    const ended = new Promise<TaskRunInfo>((resolve) => run.once('end', resolve))
    run.start()
    child.emit('exit', 2, null)
    expect(await ended).toMatchObject({ state: 'failed', exitCode: 2 })
  })

  it('flushes a trailing line that never got a newline', async () => {
    const child = new FakeChild()
    const { run } = makeRun(child)
    const lines: TaskLogLine[] = []
    run.on('line', (line: TaskLogLine) => lines.push(line))
    run.start()
    child.stdout.write('Building')
    await vi.waitFor(() => expect(child.stdout.readableLength).toBe(0))
    child.emit('exit', 0, null)
    expect(lines.some((line) => line.text === 'Building')).toBe(true)
  })

  it('strips colours and applies carriage-return overwrites', async () => {
    const child = new FakeChild()
    const { run } = makeRun(child)
    const lines: TaskLogLine[] = []
    run.on('line', (line: TaskLogLine) => lines.push(line))
    run.start()
    child.stdout.write(`${ESC}[32mdone${ESC}[39m\n`)
    child.stdout.write('10%\r50%\r100%\n')
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(3))
    expect(lines.some((line) => line.text === 'done')).toBe(true)
    expect(lines.some((line) => line.text === '100%')).toBe(true)
  })

  it('redacts secrets out of captured output', async () => {
    const child = new FakeChild()
    const { run } = makeRun(child)
    const lines: TaskLogLine[] = []
    run.on('line', (line: TaskLogLine) => lines.push(line))
    run.start()
    child.stdout.write('using key sk-abcdefghijklmnop\n')
    await vi.waitFor(() => expect(lines.some((line) => line.text.includes('sk-'))).toBe(true))
    const printed = lines.find((line) => line.text.includes('sk-'))?.text ?? ''
    expect(printed).toContain('***')
    expect(printed).not.toContain('sk-abcdefghijklmnop')
  })

  it('classifies a deliberate stop as stopped, not failed', async () => {
    const child = new FakeChild()
    const { run } = makeRun(child)
    const ended = new Promise<TaskRunInfo>((resolve) => run.once('end', resolve))
    run.start()
    const stopping = run.stop()
    // The tree kill is asynchronous; simulate the process actually dying.
    child.emit('exit', null, 'SIGTERM')
    await stopping
    expect(await ended).toMatchObject({ state: 'stopped' })
  })

  it('surfaces a spawn failure as a failed run instead of throwing', async () => {
    const { run } = makeRun(new FakeChild(), {
      spawnProcess: (() => {
        throw new Error('ENOENT npm')
      }) as unknown as typeof import('node:child_process').spawn
    })
    const ended = new Promise<TaskRunInfo>((resolve) => run.once('end', resolve))
    run.start()
    expect(await ended).toMatchObject({ state: 'failed' })
    expect(run.snapshot().some((line) => line.text.includes('ENOENT npm'))).toBe(true)
  })

  it('replays only what a client has not seen', async () => {
    const child = new FakeChild()
    const { run } = makeRun(child)
    run.start()
    child.stdout.write('one\ntwo\n')
    await vi.waitFor(() => expect(run.snapshot().length).toBeGreaterThanOrEqual(3))
    const all = run.snapshot()
    expect(run.linesAfter(all[0].seq)).toHaveLength(all.length - 1)
    expect(run.linesAfter(all[all.length - 1].seq)).toEqual([])
  })
})
