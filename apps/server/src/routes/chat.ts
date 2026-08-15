import { FastifyInstance, FastifyReply } from 'fastify'
import { request as undiciRequest } from 'undici'
import { appState } from '../appState.js'
import { config } from '../config.js'
import { getCapability, markVerified } from '../catalog/capability.js'
import { ompClient } from '../omp/rpc.js'
import { redact } from '../secure/redact.js'

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

function sseWrite(reply: FastifyReply, data: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
}

/** Build the upstream request body for the active route's wire protocol. */
export function buildUpstreamRequest(apiType: 'chat' | 'responses' | 'messages', modelId: string, messages: ChatMessage[], thinkingLevel: string | null, maxOutput: number): { path: string; body: Record<string, unknown> } {
  if (apiType === 'responses') {
    const body: Record<string, unknown> = {
      model: modelId,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true
    }
    if (thinkingLevel && ['low', 'medium', 'high'].includes(thinkingLevel)) {
      body.reasoning = { effort: thinkingLevel }
    }
    return { path: '/v1/responses', body }
  }
  if (apiType === 'messages') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: maxOutput,
      messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      stream: true
    }
    if (system) body.system = system
    return { path: '/v1/messages', body }
  }
  return {
    path: '/v1/chat/completions',
    body: { model: modelId, messages, stream: true, stream_options: { include_usage: true } }
  }
}

/** Normalize one upstream SSE data payload into {text?, inputTokens?, outputTokens?}. */
export function extractDelta(payload: Record<string, unknown>): { text?: string; inputTokens?: number; outputTokens?: number } {
  // OpenAI chat completions
  const choices = payload.choices as Array<{ delta?: { content?: string } }> | undefined
  if (choices?.[0]?.delta?.content) return { text: choices[0].delta.content }

  // OpenAI Responses API
  if (typeof payload.delta === 'string' && (payload.type as string | undefined)?.includes('output_text')) {
    return { text: payload.delta }
  }

  // Anthropic messages
  const delta = payload.delta as { text?: string } | undefined
  if ((payload.type === 'content_block_delta') && delta?.text) return { text: delta.text }

  // usage: several shapes
  const usage = (payload.usage ?? (payload.response as { usage?: unknown } | undefined)?.usage ?? (payload.message as { usage?: unknown } | undefined)?.usage) as
    | { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
    | undefined
  if (usage) {
    return {
      inputTokens: usage.prompt_tokens ?? usage.input_tokens,
      outputTokens: usage.completion_tokens ?? usage.output_tokens
    }
  }
  return {}
}

async function streamDirect(reply: FastifyReply, messages: ChatMessage[]): Promise<void> {
  const route = appState.route!
  const cap = getCapability(route.routeKey)
  const { path, body } = buildUpstreamRequest(route.apiType, route.modelId, messages, route.thinkingLevel, cap?.max_output ?? 8192)

  const abort = new AbortController()
  appState.currentAbort = abort
  reply.raw.on('close', () => abort.abort())

  const upstream = await undiciRequest(`http://127.0.0.1:${config.proxyPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: abort.signal
  })

  if (upstream.statusCode >= 400) {
    const text = await upstream.body.text()
    sseWrite(reply, { type: 'error', message: redact(text).slice(0, 2000) })
    return
  }

  let buffer = ''
  let sawUsage = false
  for await (const chunk of upstream.body) {
    buffer += chunk.toString()
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const parsed = extractDelta(JSON.parse(data))
        if (parsed.text) sseWrite(reply, { type: 'delta', text: parsed.text })
        if (parsed.inputTokens !== undefined || parsed.outputTokens !== undefined) {
          sawUsage = true
          sseWrite(reply, { type: 'usage', inputTokens: parsed.inputTokens ?? 0, outputTokens: parsed.outputTokens ?? 0 })
        }
      } catch {
        /* partial JSON across chunks is handled by line buffering; ignore stray lines */
      }
    }
  }

  // One real successful request on a documented route upgrades it to verified.
  if (cap && cap.confidence === 'documented') {
    markVerified(route.routeKey, cap.effective_context)
  }
  sseWrite(reply, { type: 'done', sawUsage })
}

/** Tolerant extractor for get_session_stats: field names vary across OMP
 *  versions, so accept snake/camel variants and common nestings. Returns
 *  CUMULATIVE session totals or null. */
export function extractSessionUsage(stats: Record<string, unknown>): { input: number; output: number } | null {
  const pick = (obj: Record<string, unknown>, names: string[]): number | undefined => {
    for (const n of names) {
      const v = obj[n]
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
    return undefined
  }
  const candidates: Record<string, unknown>[] = [stats]
  for (const key of ['usage', 'tokens', 'totals', 'stats']) {
    const nested = stats[key]
    if (nested && typeof nested === 'object') candidates.push(nested as Record<string, unknown>)
  }
  for (const obj of candidates) {
    const input = pick(obj, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'totalInputTokens'])
    const output = pick(obj, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'totalOutputTokens'])
    if (input !== undefined || output !== undefined) {
      return { input: input ?? 0, output: output ?? 0 }
    }
  }
  return null
}

/** OMP structured mode: send the newest user message, then translate OMP's
 *  AgentSessionEvent stream (rpc.md) into our SSE frames until a terminal
 *  agent_end. OMP keeps the session history itself. */
async function streamViaOmp(reply: FastifyReply, messages: ChatMessage[]): Promise<void> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  if (!lastUser) throw new Error('缺少用户消息')

  let finish!: () => void
  let fail!: (e: Error) => void
  const finished = new Promise<void>((res, rej) => {
    finish = res
    fail = rej
  })

  const onEvent = (msg: Record<string, unknown>): void => {
    const t = msg.type as string
    if (t === 'message_update') {
      const ev = msg.assistantMessageEvent as { type?: string; delta?: string } | undefined
      if (ev?.type === 'text_delta' && ev.delta) sseWrite(reply, { type: 'delta', text: ev.delta })
      return
    }
    if (t === 'tool_execution_start') {
      const name = (msg as { toolName?: string }).toolName ?? (msg as { name?: string }).name ?? '工具'
      sseWrite(reply, { type: 'delta', text: `\n⏺ 工具调用: ${name}\n` })
      return
    }
    if (t === 'agent_end' && (msg as { isTerminal?: boolean }).isTerminal !== false) {
      finish()
    }
  }
  const onExit = (): void => fail(new Error('OMP 进程退出'))
  const onClose = (): void => {
    ompClient.abortGeneration().catch(() => undefined)
    finish()
  }

  ompClient.on('event', onEvent)
  ompClient.on('exit', onExit)
  reply.raw.on('close', onClose)
  try {
    const ack = await ompClient.promptMessage(lastUser.content)
    if (!(ack && ack.agentInvoked === false)) {
      await finished
    }
    const state = await ompClient.getState().catch(() => null)
    if (state?.contextUsage) {
      sseWrite(reply, { type: 'context', ...state.contextUsage })
    }
    // Per-turn tokens = cumulative session stats minus the previous reading.
    const stats = await ompClient.call<Record<string, unknown>>('get_session_stats', {}, 5_000).catch(() => null)
    const usage = stats ? extractSessionUsage(stats) : null
    if (usage) {
      const prev = appState.lastOmpUsage
      const deltaIn = usage.input >= prev.input ? usage.input - prev.input : usage.input
      const deltaOut = usage.output >= prev.output ? usage.output - prev.output : usage.output
      appState.lastOmpUsage = usage
      if (deltaIn > 0 || deltaOut > 0) {
        sseWrite(reply, { type: 'usage', inputTokens: deltaIn, outputTokens: deltaOut })
      }
    }
    sseWrite(reply, { type: 'done' })
  } finally {
    ompClient.off('event', onEvent)
    ompClient.off('exit', onExit)
    reply.raw.off('close', onClose)
  }
}

/** Flatten an OMP AgentMessage into displayable {role, content} rows. Tool
 *  results and thinking parts are skipped; text parts are joined. */
export function normalizeAgentMessage(raw: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  const m = raw as { role?: string; content?: unknown }
  if (m.role !== 'user' && m.role !== 'assistant') return []
  if (typeof m.content === 'string') {
    return m.content.trim() ? [{ role: m.role, content: m.content }] : []
  }
  if (Array.isArray(m.content)) {
    const text = m.content
      .map((part) => {
        const p = part as { type?: string; text?: string }
        return p.type === 'text' && p.text ? p.text : ''
      })
      .filter(Boolean)
      .join('')
    return text.trim() ? [{ role: m.role, content: text }] : []
  }
  return []
}

export function registerChatRoutes(app: FastifyInstance): void {
  app.post<{ Body: { messages: ChatMessage[] } }>('/api/chat/stream', async (req, reply) => {
    if (!appState.botcf.authenticated) {
      return reply.code(401).send({ success: false, error: '未登录' })
    }
    if (!appState.route) {
      return reply.code(409).send({ success: false, error: '请先选择分组和模型' })
    }
    const messages = req.body?.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ success: false, error: 'messages 不能为空' })
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    appState.generationInFlight = true
    try {
      if (ompClient.running) {
        await streamViaOmp(reply, messages)
      } else {
        await streamDirect(reply, messages)
      }
    } catch (err: unknown) {
      const aborted = appState.currentAbort?.signal.aborted ?? false
      sseWrite(reply, aborted ? { type: 'aborted' } : { type: 'error', message: redact(err instanceof Error ? err.message : String(err)) })
    } finally {
      appState.generationInFlight = false
      appState.currentAbort = null
      reply.raw.end()
    }
  })

  app.post('/api/chat/abort', async () => {
    appState.currentAbort?.abort()
    if (ompClient.running) {
      await ompClient.abortGeneration().catch(() => undefined)
    }
    return { success: true }
  })

  /** OMP owns the durable session history; drain the paged endpoint so the UI
   *  can restore the conversation after a reload or restart. */
  app.get('/api/chat/history', async (req, reply) => {
    if (!ompClient.running) return { success: true, source: 'local', messages: [] }
    const collected: Array<{ role: string; content: string }> = []
    try {
      let cursor: string | undefined
      for (let page = 0; page < 40; page++) {
        const data = await ompClient.call<{ messages?: unknown[]; nextCursor?: string }>(
          'get_messages_page',
          cursor ? { cursor } : {}
        )
        for (const m of data.messages ?? []) collected.push(...normalizeAgentMessage(m))
        if (!data.nextCursor) break
        cursor = data.nextCursor
      }
    } catch (err: unknown) {
      // session_busy while streaming/compacting — the client just keeps local state.
      return reply.code(409).send({ success: false, error: redact(err instanceof Error ? err.message : String(err)) })
    }
    return { success: true, source: 'omp', messages: collected }
  })

  app.post('/api/chat/new', async (req, reply) => {
    if (appState.generationInFlight) {
      return reply.code(409).send({ success: false, error: '生成进行中,先中止再新建会话' })
    }
    if (ompClient.running) {
      await ompClient.call('new_session', {})
    }
    appState.lastOmpUsage = { input: 0, output: 0 }
    return { success: true }
  })

  /** Queue a steering message while a turn is streaming (OMP only). */
  app.post<{ Body: { message: string } }>('/api/chat/steer', async (req, reply) => {
    const message = req.body?.message?.trim()
    if (!message) return reply.code(400).send({ success: false, error: 'message 不能为空' })
    if (!ompClient.running) return reply.code(409).send({ success: false, error: '直连模式不支持流式中追加' })
    await ompClient.call('prompt', { message, streamingBehavior: 'steer' })
    return { success: true }
  })
}
