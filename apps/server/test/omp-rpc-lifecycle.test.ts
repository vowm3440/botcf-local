import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmpRpcClient } from '../src/omp/rpc.js'
import { readyDurationStats, resetReadyDurations, type StartupBudget } from '../src/omp/startupBudget.js'

class FakeOmpProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  kill = vi.fn(() => {
    setImmediate(() => {
      if (this.exitCode !== null) return
      this.exitCode = 0
      this.emit('exit', 0)
    })
    return true
  })

  /** Emit an RPC frame the way the real binary does: one JSON object per line. */
  send(frame: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(frame) + '\n')
  }

  /** Answer every `get_state` request, so a handshake can complete. */
  answerGetState(data: Record<string, unknown> = {}): void {
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        const request = JSON.parse(line) as { id?: string; type?: string }
        if (request.type === 'get_state') this.send({ type: 'response', id: request.id, command: 'get_state', success: true, data })
      }
    })
  }
}

function budgetOf(overrides: Partial<StartupBudget> = {}): StartupBudget {
  return {
    readyMs: 20_000,
    stateMs: 5_000,
    callMs: 30_000,
    promptMs: 90_000,
    profile: 'native',
    reason: 'test',
    ...overrides
  }
}

function makeClient(budget: StartupBudget, children: FakeOmpProcess[]): OmpRpcClient {
  return new OmpRpcClient({
    spawnProcess: (() => {
      const child = new FakeOmpProcess()
      children.push(child)
      return child
    }) as unknown as typeof import('node:child_process').spawn,
    syncModelsConfig: () => undefined,
    binaryPath: () => 'fake-omp',
    binaryExists: () => true,
    budget: () => budget
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('OmpRpcClient lifecycle', () => {
  it('ignores frames and exits from a retired process after restarting', async () => {
    const children: FakeOmpProcess[] = []
    const client = makeClient(budgetOf(), children)
    const events: Record<string, unknown>[] = []
    client.on('event', (event) => events.push(event))

    await client.start()
    await client.stop()
    await client.start()
    try {
      children[0].emit('exit', 0)
      children[0].send({ type: 'ready' })
      children[0].send({ type: 'extension_ui_request', method: 'confirm', id: 'retired-dialog' })
      expect(client.running).toBe(false)
      expect(events).toEqual([])

      children[1].answerGetState()
      children[1].send({ type: 'ready' })
      expect(await client.handshake()).toBe(true)
      children[1].send({ type: 'extension_ui_request', method: 'confirm', id: 'current-dialog' })
      expect(events).toEqual([{ type: 'extension_ui_request', method: 'confirm', id: 'current-dialog' }])
    } finally {
      await client.stop()
    }
  })
})

describe('OmpRpcClient handshake budget', () => {
  it('accepts a ready frame that lands after the old fixed 10 s window', async () => {
    vi.useFakeTimers()
    resetReadyDurations()
    const children: FakeOmpProcess[] = []
    // The arm64 image under QEMU: alive the whole time, just slow to speak.
    const client = makeClient(budgetOf({ readyMs: 240_000, stateMs: 30_000, profile: 'emulated' }), children)

    await client.start()
    children[0].answerGetState()
    const handshake = client.handshake()

    await vi.advanceTimersByTimeAsync(15_000)
    children[0].send({ type: 'ready' })
    await vi.advanceTimersByTimeAsync(10)

    expect(await handshake).toBe(true)
    expect(client.running).toBe(true)
    expect(client.lastProtocolError).toBeNull()
    // The measurement that should drive the next change to these ceilings.
    expect(readyDurationStats().samples).toBe(1)
    expect(client.lastReadyMs).not.toBeNull()
  })

  it('fails the moment the child exits instead of waiting out the budget', async () => {
    const children: FakeOmpProcess[] = []
    const client = makeClient(budgetOf({ readyMs: 600_000, stateMs: 120_000 }), children)

    await client.start()
    const handshake = client.handshake()
    const started = Date.now()
    children[0].exitCode = 1
    children[0].emit('exit', 1)

    expect(await handshake).toBe(false)
    // A broken binary stays a millisecond-scale failure even with a ten-minute
    // ceiling — that is what makes the wider ceiling safe.
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(client.lastProtocolError).toContain('已退出')
  })

  it('times out at the budget ceiling rather than a hard-coded 10 s', async () => {
    const children: FakeOmpProcess[] = []
    const client = makeClient(budgetOf({ readyMs: 120 }), children)

    await client.start()
    expect(await client.handshake()).toBe(false)
    expect(client.lastProtocolError).toContain('等待 ready 帧超时')
    expect(client.running).toBe(false)
  })

  it('keeps get_state on its own timeout, not the startup budget', async () => {
    const children: FakeOmpProcess[] = []
    // Startup may take ten minutes; a process that never answers get_state is
    // still caught in a fraction of a second.
    const client = makeClient(budgetOf({ readyMs: 600_000, stateMs: 150 }), children)

    await client.start()
    const handshake = client.handshake()
    children[0].send({ type: 'ready' })
    const started = Date.now()

    expect(await handshake).toBe(false)
    expect(client.lastProtocolError).toContain('OMP RPC 超时: get_state')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('lets an explicit override win over the machine budget', async () => {
    const children: FakeOmpProcess[] = []
    const client = makeClient(budgetOf({ readyMs: 600_000 }), children)

    await client.start()
    expect(await client.handshake({ readyMs: 100 })).toBe(false)
    expect(client.lastProtocolError).toContain('等待 ready 帧超时')
  })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The fixture writes its pids a moment after spawn; poll for the file. */
async function readTreePids(file: string): Promise<{ parent: number; grandchild: number }> {
  const until = Date.now() + 5_000
  while (Date.now() < until) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as { parent: number; grandchild: number }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`pid 文件未在 5s 内出现: ${file}`)
}

describe('OmpRpcClient process-tree reclamation', () => {
  it('stop() reaps grandchildren the OMP child spawned', async () => {
    const pidFile = path.join(os.tmpdir(), `botcf-omp-tree-${process.pid}-${Date.now()}.json`)
    const fixture = fileURLToPath(new URL('./fixtures/omp-tree-child.cjs', import.meta.url))
    // Windows cannot exec a .cjs directly (spawn EFTYPE), so the seam runs the
    // fixture under node while still returning a real child process with a pid.
    const spawnFixture: typeof spawn = (_file, args, options) =>
      spawn(process.execPath, [fixture, ...(args as string[])], options)
    const client = new OmpRpcClient({
      spawnProcess: spawnFixture,
      syncModelsConfig: () => undefined,
      binaryPath: () => process.execPath,
      binaryExists: () => true,
      budget: () => budgetOf()
    })
    process.env.OMP_TREE_PID_FILE = pidFile
    try {
      expect(await client.start()).toBe(true)
      const pids = await readTreePids(pidFile)
      expect(typeof pids.parent).toBe('number')
      expect(typeof pids.grandchild).toBe('number')
      expect(isAlive(pids.parent)).toBe(true)
      expect(isAlive(pids.grandchild)).toBe(true)

      await client.stop()

      // taskkill (win32) and the group signal (POSIX) settle after the direct
      // child exits, so poll instead of asserting on the first tick.
      await vi.waitFor(() => expect(isAlive(pids.parent)).toBe(false), { timeout: 8_000, interval: 100 })
      await vi.waitFor(() => expect(isAlive(pids.grandchild)).toBe(false), { timeout: 8_000, interval: 100 })
    } finally {
      delete process.env.OMP_TREE_PID_FILE
      await client.stop()
      fs.rmSync(pidFile, { force: true })
    }
  })
})
