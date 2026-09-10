import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_RPC_FRAME_BYTES, MAX_RPC_PENDING, OmpRpcClient } from '../src/omp/rpc.js'
import type { StartupBudget } from '../src/omp/startupBudget.js'

/** stdin double whose write() obeys a software backpressure flag: while blocked
 *  every write returns false and the client must wait for `drain` before the
 *  next frame. Each accepted frame earns a response on stdout so pending calls
 *  settle exactly like they do against the real binary. */
class BackpressuredStdin extends EventEmitter {
  writable = true
  blocked = false
  written: string[] = []
  /** Frames accepted while blocked; flushed (with their responses) on unblock. */
  private buffered: string[] = []
  constructor(private readonly respond: (frame: string) => void) {
    super()
  }
  write(frame: string): boolean {
    this.written.push(frame)
    if (this.blocked) {
      this.buffered.push(frame)
      return false
    }
    setImmediate(() => this.respond(frame))
    return true
  }
  block(): void {
    this.blocked = true
  }
  unblock(): void {
    this.blocked = false
    for (const frame of this.buffered.splice(0)) setImmediate(() => this.respond(frame))
    this.emit('drain')
  }
}

class BackpressuredChild extends EventEmitter {
  stdin: BackpressuredStdin
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined
  exitCode: number | null = null
  kill = vi.fn(() => {
    setImmediate(() => {
      if (this.exitCode !== null) return
      this.exitCode = 0
      this.emit('exit', 0)
    })
    return true
  })
  constructor(respondEnabled = true) {
    super()
    this.stdin = new BackpressuredStdin((frame) => {
      if (!respondEnabled) return
      const request = JSON.parse(frame) as { id?: string; type?: string; index?: number }
      this.stdout.write(
        JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: { index: request.index } }) + '\n'
      )
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

function makeClient(child: BackpressuredChild, budget: StartupBudget = budgetOf()): OmpRpcClient {
  return new OmpRpcClient({
    spawnProcess: (() => child) as unknown as typeof spawn,
    syncModelsConfig: () => undefined,
    binaryPath: () => 'fake-omp',
    binaryExists: () => true,
    budget: () => budget
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('OmpRpcClient backpressure', () => {
  it('serializes stdin writes and waits for drain instead of buffering a burst', async () => {
    const child = new BackpressuredChild()
    const client = makeClient(child)
    try {
      await client.start()
      child.stdin.block()

      const results = Array.from({ length: 5 }, (_, index) =>
        client.call<{ index: number }>('probe', { index }).then((data) => data.index)
      )
      // Only the first frame may reach the pipe while it is blocked; the rest
      // stay queued behind the drain wait instead of piling into the buffer.
      await new Promise((resolve) => setImmediate(resolve))
      expect(child.stdin.written).toHaveLength(1)

      child.stdin.unblock()
      await expect(Promise.all(results)).resolves.toEqual([0, 1, 2, 3, 4])
      expect(child.stdin.written).toHaveLength(5)
      // Frame order is preserved under serialization.
      const indexes = child.stdin.written.map((frame) => (JSON.parse(frame) as { index: number }).index)
      expect(indexes).toEqual([0, 1, 2, 3, 4])
    } finally {
      await client.stop()
    }
  })

  it('refuses calls once more than MAX_RPC_PENDING are awaiting a response', async () => {
    const child = new BackpressuredChild(false)
    const client = makeClient(child, budgetOf({ callMs: 60_000 }))
    const stderr: string[] = []
    client.on('stderr', (line) => stderr.push(line))
    try {
      await client.start()
      // With no responses the first MAX_RPC_PENDING calls stay in flight; every
      // further call must be refused on the spot instead of being queued.
      const inFlight: Array<Promise<string>> = []
      const refused: string[] = []
      for (let index = 0; index < MAX_RPC_PENDING + 4; index++) {
        const outcome = client.call('noop', { index }).then(() => 'ok', (error) => (error as Error).message)
        if (index < MAX_RPC_PENDING) inFlight.push(outcome)
        else refused.push(await outcome)
      }
      expect(refused).toHaveLength(4)
      expect(refused.every((message) => message.includes('请求堆积'))).toBe(true)
      expect(stderr.some((line) => line.includes('请求堆积'))).toBe(true)

      await client.stop()
      const settled = await Promise.all(inFlight)
      expect(settled.every((message) => message.includes('已停止'))).toBe(true)
    } finally {
      await client.stop()
    }
  })

  it('keeps the pipe to one buffered frame across a 5000-frame burst', async () => {
    const child = new BackpressuredChild()
    const client = makeClient(child)
    try {
      await client.start()
      child.stdin.block()
      // A 5000 fps event flood: while the pipe is blocked the client may not
      // pile frames into the buffer - it waits for drain after the first one.
      for (let index = 0; index < 5000; index++) {
        client.sendFrame({ type: 'extension_ui_response', id: String(index) })
      }
      await new Promise((resolve) => setImmediate(resolve))
      expect(child.stdin.written.length).toBeLessThanOrEqual(1)

      child.stdin.unblock()
      await new Promise((resolve) => setImmediate(resolve))
      expect(child.stdin.written).toHaveLength(5000)
    } finally {
      await client.stop()
    }
  })

  it('drops a frame over the 4 MiB ceiling with a stderr note instead of writing it', async () => {
    const child = new BackpressuredChild()
    const client = makeClient(child)
    const stderr: string[] = []
    client.on('stderr', (line) => stderr.push(line))
    try {
      await client.start()
      const blob = 'x'.repeat(MAX_RPC_FRAME_BYTES)
      await expect(client.call('echo', { blob })).rejects.toThrow(/帧过大/)
      expect(child.stdin.written).toHaveLength(0)

      client.sendFrame({ type: 'extension_ui_response', id: '1', blob })
      expect(child.stdin.written).toHaveLength(0)
      expect(stderr.some((line) => line.includes('帧过大已丢弃'))).toBe(true)
    } finally {
      await client.stop()
    }
  })
})
