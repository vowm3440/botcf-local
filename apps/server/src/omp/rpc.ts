import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { config } from '../config.js'
import { getDb } from '../db.js'

/** oh-my-pi RPC wire contract (docs/rpc.md, verified against v17.3.x):
 *  - stdin:  {id?: string, type: "<command>", ...params} one JSON per line
 *  - stdout: {type:"ready",...} once at startup, then {type:"response", id?,
 *    command, success, data?|error} plus AgentSessionEvent frames. */

export interface OmpModelRef {
  provider: string
  id: string
}

export interface OmpState {
  model?: OmpModelRef
  thinkingLevel?: string
  isStreaming?: boolean
  contextUsage?: { tokens: number; contextWindow: number; percent: number }
  [k: string]: unknown
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** Thinking levels OMP accepts (rpc.md get_state payload). */
export const OMP_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function ompBinaryPath(): string {
  const name = process.platform === 'win32' ? 'omp.exe' : 'omp'
  return path.join(config.ompDir, 'current', name)
}

export interface BotcfModelConfigRow {
  model_id: string
  api_type: 'responses' | 'chat' | 'messages'
  effective_context: number
  max_output: number
}

interface CustomModel {
  id: string
  name: string
  api: string
  reasoning: boolean
  supportsTools: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
}

interface CustomProvider {
  baseUrl: string
  apiKey: string
  api: string
  models: CustomModel[]
}

export interface BotcfModelsConfig {
  providers: Record<string, CustomProvider>
}

/** Build an app-owned OMP provider catalog. The proxy owns credentials and wire
 *  routing; OMP receives only the loopback URL and effective context limits. */
export function buildBotcfModelsConfig(rows: BotcfModelConfigRow[], proxyBase: string, proxyToken: string): BotcfModelsConfig {
  const definitions = {
    responses: { provider: 'botcf-responses', api: 'openai-responses', baseUrl: `${proxyBase}/v1` },
    chat: { provider: 'botcf-chat', api: 'openai-completions', baseUrl: `${proxyBase}/v1` },
    messages: { provider: 'botcf-messages', api: 'anthropic-messages', baseUrl: proxyBase }
  } as const
  const modelMaps = new Map<string, Map<string, CustomModel>>()
  for (const definition of Object.values(definitions)) modelMaps.set(definition.provider, new Map())
  for (const row of rows) {
    const definition = definitions[row.api_type]
    const models = modelMaps.get(definition.provider)!
    const existing = models.get(row.model_id)
    models.set(row.model_id, {
      id: row.model_id,
      name: row.model_id,
      api: definition.api,
      reasoning: true,
      supportsTools: true,
      input: ['text'],
      contextWindow: Math.max(row.effective_context, existing?.contextWindow ?? 0),
      maxTokens: Math.max(row.max_output, existing?.maxTokens ?? 0)
    })
  }
  const providers: Record<string, CustomProvider> = {}
  for (const definition of Object.values(definitions)) {
    providers[definition.provider] = {
      baseUrl: definition.baseUrl,
      apiKey: proxyToken,
      api: definition.api,
      models: [...modelMaps.get(definition.provider)!.values()]
    }
  }
  return { providers }
}

export function ompAgentDir(): string {
  return path.join(config.ompDir, 'agent')
}

/** Persist the generated catalog before OMP starts. Returns true when a running
 *  process must be restarted to observe a changed model list or context limit. */
export function syncBotcfModelsConfig(): boolean {
  const rows = getDb()
    .prepare('SELECT model_id, api_type, effective_context, max_output FROM model_capabilities')
    .all() as unknown as BotcfModelConfigRow[]
  const content = JSON.stringify(buildBotcfModelsConfig(rows, `http://127.0.0.1:${config.proxyPort}`, config.proxyToken), null, 2) + '\n'
  const agentDir = ompAgentDir()
  const file = path.join(agentDir, 'models.yml')
  fs.mkdirSync(agentDir, { recursive: true })
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (previous === content) return false
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 })
  return true
}

export class OmpRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<string, Pending>()
  private readyResolvers: Array<() => void> = []
  private isReady = false
  /** Set when the spawned binary doesn't complete our handshake — the app
   *  then stays in direct mode instead of hanging on every call. */
  lastProtocolError: string | null = null
  /** Working directory for the agent (the user's project). Applied on next start. */
  workdir: string | null = null

  get available(): boolean {
    return fs.existsSync(ompBinaryPath())
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.isReady
  }

  async start(): Promise<boolean> {
    if (this.child && this.child.exitCode === null) return true
    if (!this.available) return false
    syncBotcfModelsConfig()

    this.isReady = false
    const proxyBase = `http://127.0.0.1:${config.proxyPort}`
    const child = spawn(ompBinaryPath(), ['--mode', 'rpc'], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: ompAgentDir(),
        OMP_SKIP_SETUP: '1',
        // OMP only ever sees the local credential proxy, never real keys.
        OPENAI_BASE_URL: `${proxyBase}/v1`,
        OPENAI_API_KEY: config.proxyToken,
        ANTHROPIC_BASE_URL: proxyBase,
        ANTHROPIC_API_KEY: config.proxyToken
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.workdir && fs.existsSync(this.workdir) ? this.workdir : undefined
    })
    this.child = child as ChildProcessWithoutNullStreams

    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line))
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => this.emit('stderr', line))

    child.on('error', (err) => {
      this.lastProtocolError = `OMP 启动失败: ${err.message}`
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
      this.child = null
      this.isReady = false
      this.emit('exit', -1)
    })

    child.on('exit', (code) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(`OMP 进程已退出 (code=${code})`))
      }
      this.pending.clear()
      this.child = null
      this.isReady = false
      this.emit('exit', code)
    })
    return true
  }

  async stop(): Promise<void> {
    this.child?.kill()
    this.child = null
    this.isReady = false
  }

  private waitReady(timeoutMs: number): Promise<void> {
    if (this.isReady) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 ready 帧超时')), timeoutMs)
      this.readyResolvers.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Wait for the ready frame, then verify get_state answers. On failure the
   *  child is killed and the reason recorded; callers fall back to direct mode. */
  async handshake(timeoutMs = 10_000): Promise<boolean> {
    if (!this.child || this.child.exitCode !== null) return false
    try {
      await this.waitReady(timeoutMs)
      await this.call('get_state', {}, 5_000)
      this.lastProtocolError = null
      return true
    } catch (err: unknown) {
      this.lastProtocolError = `RPC 握手失败: ${err instanceof Error ? err.message : String(err)}`
      await this.stop()
      return false
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      this.emit('stderr', line)
      return
    }
    const type = msg.type as string | undefined

    if (type === 'ready') {
      this.isReady = true
      for (const r of this.readyResolvers.splice(0)) r()
      this.emit('ready', msg)
      return
    }
    if (type === 'response') {
      const id = msg.id as string | undefined
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!
        this.pending.delete(id)
        clearTimeout(p.timer)
        if (msg.success) p.resolve(msg.data)
        else p.reject(new Error(String(msg.error ?? `命令失败: ${String(msg.command)}`)))
      }
      return
    }
    // Everything else is an AgentSessionEvent / side-channel frame.
    this.emit('event', msg)
  }

  async call<T = unknown>(type: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.child || this.child.exitCode !== null) throw new Error('OMP RPC 未运行')
    const id = `req_${this.nextId++}`
    const payload = JSON.stringify({ id, type, ...params })
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`OMP RPC 超时: ${type}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.child!.stdin.write(payload + '\n')
    })
  }

  /** Fire-and-forget frame without response correlation — used for the
   *  extension-UI sub-protocol ({type:"extension_ui_response", ...}). */
  sendFrame(frame: Record<string, unknown>): void {
    if (!this.child || this.child.exitCode !== null) throw new Error('OMP RPC 未运行')
    this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  getAvailableModels(): Promise<unknown> {
    return this.call('get_available_models')
  }

  setModel(provider: string, modelId: string): Promise<unknown> {
    return this.call('set_model', { provider, modelId })
  }

  setThinkingLevel(level: string): Promise<unknown> {
    return this.call('set_thinking_level', { level })
  }

  getState(): Promise<OmpState> {
    return this.call<OmpState>('get_state')
  }

  /** Ack is immediate; completion arrives via agent_end events (isTerminal !== false). */
  promptMessage(message: string): Promise<{ agentInvoked?: boolean } | undefined> {
    return this.call('prompt', { message })
  }

  /** Installed-version smoke: model selection plus one real prompt. The caller
   *  must restart this client first so the probe exercises the newly linked binary. */
  async smokeTest(provider: string, modelId: string, timeoutMs = 90_000): Promise<boolean> {
    const marker = 'BOTCF_OMP_SMOKE_OK'
    await this.setModel(provider, modelId)
    let stopWaiting = () => {}
    const terminal = new Promise<void>((resolve, reject) => {
      const onEvent = (event: Record<string, unknown>) => {
        if (event.type !== 'agent_end' || event.isTerminal === false) return
        stopWaiting()
        resolve()
      }
      const timer = setTimeout(() => {
        stopWaiting()
        reject(new Error('OMP 冒烟 prompt 超时'))
      }, timeoutMs)
      stopWaiting = () => {
        clearTimeout(timer)
        this.off('event', onEvent)
      }
      this.on('event', onEvent)
    })
    try {
      const result = await this.promptMessage(`Reply exactly ${marker}. Do not call tools.`)
      if (result?.agentInvoked === false) return false
      await terminal
      const response = await this.call<{ text: string | null }>('get_last_assistant_text')
      return response.text?.includes(marker) === true
    } finally {
      stopWaiting()
    }
  }

  abortGeneration(): Promise<unknown> {
    return this.call('abort')
  }
}

export const ompClient = new OmpRpcClient()
