import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { MAX_RUN_LINES, TaskRun, type TaskLogLine, type TaskRunInfo, type TaskRunOptions } from '../src/tasks/runner.js'

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
    child.emit('close', 0, null)
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
    child.emit('close', 2, null)
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
    child.emit('close', 0, null)
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
    child.emit('close', null, 'SIGTERM')
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

  it('finishes an asynchronous spawn failure that never emits exit', () => {
    const child = new FakeChild()
    const { run } = makeRun(child)
    const ended = vi.fn()
    run.on('end', ended)
    run.start()
    child.emit('error', new Error('spawn ENOENT'))
    child.emit('close', -2, null)
    expect(run.info()).toMatchObject({ state: 'failed', exitCode: -2 })
    expect(run.running).toBe(false)
    expect(ended).toHaveBeenCalledOnce()
  })

  it('includes output arriving after exit in the completed transcript', () => {
    const child = new FakeChild()
    const { run } = makeRun(child)
    let transcript: string[] = []
    run.on('end', () => { transcript = run.snapshot().map((line) => line.text) })
    run.start()
    child.emit('exit', 0, null)
    child.stdout.write('final diagnostic')
    child.emit('close', 0, null)
    expect(transcript).toContain('final diagnostic')
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

  it('keeps every line in the transcript file after the ring buffer turns over', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-run-log-'))
    try {
      const file = path.join(dir, 'run.log')
      const child = new FakeChild()
      const { run } = makeRun(child, { transcriptFile: file })
      const seen: string[] = []
      run.on('line', (line: TaskLogLine) => {
        if (line.stream === 'stdout') seen.push(line.text)
      })
      const ended = new Promise<TaskRunInfo>((resolve) => run.once('end', resolve))
      run.start()
      const total = MAX_RUN_LINES + 50
      for (let i = 0; i < total; i++) child.stdout.write(`line ${i}\n`)
      await vi.waitFor(() => expect(seen.length).toBe(total))
      child.emit('close', 0, null)
      await ended
      // The ring buffer dropped the head of the run…
      expect(run.snapshot().length).toBe(MAX_RUN_LINES)
      // …while the disk transcript still has every line, in order.
      const text = fs.readFileSync(file, 'utf8')
      const fileLines = text.split('\n').filter((line) => line.startsWith('line '))
      expect(fileLines).toHaveLength(total)
      expect(fileLines[0]).toBe('line 0')
      expect(fileLines[total - 1]).toBe(`line ${total - 1}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the run healthy when the transcript cannot be written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-run-log-'))
    try {
      // A file where the transcript directory would be: every write fails.
      const blocker = path.join(dir, 'blocker')
      fs.writeFileSync(blocker, 'x')
      const child = new FakeChild()
      const { run } = makeRun(child, { transcriptFile: path.join(blocker, 'run.log') })
      const ended = new Promise<TaskRunInfo>((resolve) => run.once('end', resolve))
      run.start()
      child.stdout.write('still captured\n')
      await vi.waitFor(() => expect(run.snapshot().some((line) => line.text === 'still captured')).toBe(true))
      child.emit('close', 0, null)
      expect(await ended).toMatchObject({ state: 'succeeded' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
