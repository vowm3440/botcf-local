import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appState, applyActiveRouteToOmp, type ActiveRouteInfo } from '../src/appState.js'
import { OmpRpcClient } from '../src/omp/rpc.js'
import { restartRuntime, type RuntimeControl } from '../src/omp/runtime.js'

/** Route contract across a runtime restart, over the real RPC wire.
 *
 *  omp-runtime.test.ts injects `applyRoute` to pin the *order* of the restart
 *  transaction; that seam cannot show what the original P1 bug actually was. OMP
 *  persists its own model selection and restores it on start, so switching the
 *  primary root brought the process back on last week's provider while the UI still
 *  showed the route the user picked — and the credential proxy answered 409 on the
 *  next message. What has to be verified is therefore the wire: which frames a
 *  restart sends, that `get_state` afterwards agrees with the active route, and that
 *  a prompt then goes through. So the only thing faked here is the omp binary. */

interface Persisted {
  model: { provider: string; id: string } | null
  thinkingLevel: string | null
}

/** Stand-in for `omp --mode rpc` (docs/rpc.md): one JSON request per stdin line,
 *  a single {type:"ready"} at startup, then {type:"response", id, command, success,
 *  data} per request. Its selection lives in a store shared by every process the
 *  test spawns, which is exactly what "OMP restores its persisted model" means. */
class FakeOmp extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  /** Every command received, in order — the wire this test is about. */
  readonly received: Array<Record<string, unknown>> = []

  constructor(
    private readonly persisted: Persisted,
    private readonly options: { obeySetModel?: boolean } = {}
  ) {
    super()
    readline.createInterface({ input: this.stdin }).on('line', (line) => this.onLine(line))
    setImmediate(() => this.emitFrame({ type: 'ready', version: '17.3.0' }))
  }

  kill = vi.fn((): boolean => {
    setImmediate(() => {
      if (this.exitCode !== null) return
      this.exitCode = 0
      this.emit('exit', 0)
    })
    return true
  })

  commands(): string[] {
    return this.received.map((frame) => String(frame.type))
  }

  private emitFrame(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`)
  }

  private respond(id: unknown, command: string, data: unknown): void {
    this.emitFrame({ type: 'response', id, command, success: true, data })
  }

  private onLine(line: string): void {
    const frame = JSON.parse(line) as Record<string, unknown>
    this.received.push(frame)
    const command = String(frame.type)
    if (command === 'set_model') {
      // A binary that ignores the selection is the failure mode the state check is
      // for: the handshake still answers, so nothing else would notice.
      if (this.options.obeySetModel !== false) {
        this.persisted.model = { provider: String(frame.provider), id: String(frame.modelId) }
      }
      this.respond(frame.id, command, { ok: true })
      return
    }
    if (command === 'set_thinking_level') {
      this.persisted.thinkingLevel = String(frame.level)
      this.respond(frame.id, command, { ok: true })
      return
    }
    if (command === 'get_state') {
      this.respond(frame.id, command, {
        ...(this.persisted.model ? { model: this.persisted.model } : {}),
        ...(this.persisted.thinkingLevel ? { thinkingLevel: this.persisted.thinkingLevel } : {}),
        isStreaming: false
      })
      return
    }
    if (command === 'prompt') {
      this.respond(frame.id, command, { agentInvoked: true })
      return
    }
    this.respond(frame.id, command, {})
  }
}

interface Harness {
  client: OmpRpcClient
  processes: FakeOmp[]
  persisted: Persisted
  /** The restart transaction, wired to this client and the real route application. */
  control: (options?: { configChanged?: boolean }) => RuntimeControl
}

function harness(options: { persisted?: Persisted; obeySetModel?: boolean } = {}): Harness {
  // Whatever the previous session left OMP on — a provider the app never selected.
  const persisted = options.persisted ?? { model: { provider: 'anthropic', id: 'claude-opus-4-8' }, thinkingLevel: null }
  const processes: FakeOmp[] = []
  const client = new OmpRpcClient({
    spawnProcess: ((): FakeOmp => {
      const child = new FakeOmp(persisted, { ...(options.obeySetModel !== undefined ? { obeySetModel: options.obeySetModel } : {}) })
      processes.push(child)
      return child
    }) as unknown as typeof import('node:child_process').spawn,
    syncModelsConfig: () => undefined,
    binaryPath: () => 'fake-omp',
    binaryExists: () => true
  })
  return {
    client,
    processes,
    persisted,
    control: (controlOptions = {}) => ({
      available: () => client.available,
      stop: () => client.stop(),
      start: () => client.start(),
      handshake: () => client.handshake(),
      lastError: () => client.lastProtocolError,
      hasRoute: () => appState.route !== null,
      // The step under test, unstubbed: it talks to the fake binary over stdio.
      applyRoute: () => applyActiveRouteToOmp(client, () => controlOptions.configChanged === true)
    })
  }
}

function route(overrides: Partial<ActiveRouteInfo> = {}): ActiveRouteInfo {
  return {
    group: 'grok',
    modelId: 'grok-4.6',
    apiType: 'chat',
    thinkingLevel: 'high',
    routeKey: 'grok:grok-4.6',
    tokenName: 'botcf-grok',
    capabilityLabel: 'Grok 4.6',
    effectiveContext: 256_000,
    ...overrides
  }
}

const activeClients: OmpRpcClient[] = []

function track(client: OmpRpcClient): OmpRpcClient {
  activeClients.push(client)
  return client
}

afterEach(async () => {
  appState.route = null
  for (const client of activeClients.splice(0)) await client.stop()
})

describe('restart → route contract over RPC', () => {
  it('brings the agent back on the route the user picked, and takes a prompt there', async () => {
    const { client, processes, control } = harness()
    track(client)
    appState.route = route()

    expect(await restartRuntime(control())).toEqual({ status: 'restarted', error: null })

    const omp = processes.at(-1)!
    // The handshake verifies the process answers; the route is then asserted and
    // read back. Without that last get_state a mismatch is invisible until a 409.
    expect(omp.commands()).toEqual(['get_state', 'set_model', 'set_thinking_level', 'get_state'])
    expect(omp.received[1]).toMatchObject({ type: 'set_model', provider: 'botcf-chat', modelId: 'grok-4.6' })
    expect(omp.received[2]).toMatchObject({ type: 'set_thinking_level', level: 'high' })

    // What the UI shows and what the process carries now agree.
    expect(await client.getState()).toMatchObject({
      model: { provider: 'botcf-chat', id: 'grok-4.6' },
      thinkingLevel: 'high'
    })
    expect(await client.promptMessage('ping')).toEqual({ agentInvoked: true })
  })

  it('survives a second restart — the persisted model is re-overwritten every time', async () => {
    const { client, processes, control } = harness()
    track(client)
    appState.route = route()

    expect(await restartRuntime(control())).toEqual({ status: 'restarted', error: null })
    // 切换主目录一次、显式重启一次:第二次进程带着上一次的选择起来,仍要被重新断言。
    expect(await restartRuntime(control())).toEqual({ status: 'restarted', error: null })

    expect(processes).toHaveLength(2)
    expect(processes[1].commands()).toEqual(['get_state', 'set_model', 'set_thinking_level', 'get_state'])
    expect(await client.getState()).toMatchObject({ model: { provider: 'botcf-chat', id: 'grok-4.6' } })
  })

  it('sends the provider the route\'s wire protocol implies', async () => {
    for (const [apiType, provider] of [
      ['chat', 'botcf-chat'],
      ['responses', 'botcf-responses'],
      ['messages', 'botcf-messages']
    ] as const) {
      const { client, processes, control } = harness()
      track(client)
      appState.route = route({ apiType, modelId: `model-${apiType}`, thinkingLevel: null })

      expect(await restartRuntime(control())).toEqual({ status: 'restarted', error: null })
      expect(processes.at(-1)!.received[1]).toMatchObject({ type: 'set_model', provider, modelId: `model-${apiType}` })
      // No thinking level on this route: nothing is sent rather than a default one.
      expect(processes.at(-1)!.commands()).toEqual(['get_state', 'set_model', 'get_state'])
      await client.stop()
    }
  })

  it('refuses to hand a prompt to a process that came back on another model', async () => {
    const { client, processes, control } = harness({ obeySetModel: false })
    track(client)
    appState.route = route()

    const result = await restartRuntime(control())

    expect(result.status).toBe('failed')
    expect(result.error).toContain('OMP 状态校验失败')
    expect(result.error).toContain('botcf-chat/grok-4.6')
    expect(result.error).toContain('anthropic/claude-opus-4-8')
    // Left stopped, not running with a model nobody selected: direct mode still
    // honours the active route, a mismatched agent process does not.
    expect(client.running).toBe(false)
    expect(processes.at(-1)!.kill).toHaveBeenCalled()
  })

  it('applies the route to the fresh process when the model catalog changed', async () => {
    const { client, processes, control } = harness()
    track(client)
    appState.route = route()

    // A changed models.yml only takes effect on start, so the route has to be
    // asserted against the process that read the new file — not the old one.
    expect(await restartRuntime(control({ configChanged: true }))).toEqual({ status: 'restarted', error: null })

    expect(processes).toHaveLength(2)
    expect(processes[0].commands()).toEqual(['get_state'])
    expect(processes[1].commands()).toEqual(['get_state', 'set_model', 'set_thinking_level', 'get_state'])
    expect(await client.getState()).toMatchObject({ model: { provider: 'botcf-chat', id: 'grok-4.6' } })
  })

  it('reports a fresh install with no route as restarted, and sends no selection', async () => {
    const { client, processes, control } = harness({ persisted: { model: null, thinkingLevel: null } })
    track(client)
    appState.route = null

    expect(await restartRuntime(control())).toEqual({ status: 'restarted', error: null })
    expect(processes.at(-1)!.commands()).toEqual(['get_state'])
  })
})
