import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
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
  it('waits for the old process and ignores its stale exit events', async () => {
    const children: FakeOmpProcess[] = []
    const client = makeClient(budgetOf(), children)

    await client.start()
    await client.stop()
    await client.start()

    children[0].emit('exit', 0)
    await client.start()

    expect(children).toHaveLength(2)
    expect(children[0].kill).toHaveBeenCalledTimes(1)
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
