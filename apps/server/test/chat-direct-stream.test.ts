import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from 'undici'
import type * as Undici from 'undici'
import type * as Capability from '../src/catalog/capability.js'
import { appState } from '../src/appState.js'
import { registerChatRoutes } from '../src/routes/chat.js'
import { ompClient } from '../src/omp/rpc.js'

vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof Undici>(),
  request: vi.fn()
}))
vi.mock('../src/catalog/capability.js', async (importOriginal) => ({
  ...await importOriginal<typeof Capability>(),
  getCapability: () => undefined
}))

const originalThirdParty = appState.thirdParty
const originalRoute = appState.route

afterEach(() => {
  appState.thirdParty = originalThirdParty
  appState.route = originalRoute
  appState.generationInFlight = false
  appState.currentAbort = null
  vi.restoreAllMocks()
})

async function stream(chunks: Buffer[]) {
  appState.thirdParty = { baseUrl: 'http://unused.invalid', models: ['claude-test'] }
  appState.route = {
    group: '第三方', modelId: 'claude-test', apiType: 'messages', thinkingLevel: null,
    routeKey: 'direct-stream-test', tokenName: 'test', capabilityLabel: 'test', effectiveContext: 200_000
  }
  vi.spyOn(ompClient, 'running', 'get').mockReturnValue(false)
  vi.mocked(request).mockResolvedValue({
    statusCode: 200,
    body: (async function* () { for (const chunk of chunks) yield chunk })()
  } as unknown as Undici.Dispatcher.ResponseData)
  const app = Fastify()
  registerChatRoutes(app)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { messages: [{ role: 'user', content: 'hello' }] } })
    expect(response.statusCode).toBe(200)
    return response.body.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
  } finally {
    await app.close()
  }
}

const frame = (payload: unknown) => Buffer.from(`data: ${JSON.stringify(payload)}\n\n`)


describe('/api/chat/history pagination', () => {
  const agentMessage = (role: string, content: string) => ({ role, content: [{ type: 'text', text: content }] })

  async function getHistory(url: string) {
    const app = Fastify()
    registerChatRoutes(app)
    try {
      const response = await app.inject({ method: 'GET', url })
      return { statusCode: response.statusCode, json: response.json() as Record<string, unknown> }
    } finally {
      await app.close()
    }
  }

  it('drains every page when no cursor/limit are given (legacy contract)', async () => {
    vi.spyOn(ompClient, 'running', 'get').mockReturnValue(true)
    const call = vi.spyOn(ompClient, 'call')
    call.mockResolvedValueOnce({ messages: [agentMessage('user', 'first')], nextCursor: 'c1' } as never)
    call.mockResolvedValueOnce({ messages: [agentMessage('assistant', 'second')], totalMessages: 2 } as never)

    const { statusCode, json } = await getHistory('/api/chat/history')
    expect(statusCode).toBe(200)
    expect(json).toEqual({
      success: true,
      source: 'omp',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' }
      ]
    })
    expect(call).toHaveBeenNthCalledWith(1, 'get_messages_page', {})
    expect(call).toHaveBeenNthCalledWith(2, 'get_messages_page', { cursor: 'c1' })
  })

  it('passes cursor/limit through and returns one bounded page', async () => {
    vi.spyOn(ompClient, 'running', 'get').mockReturnValue(true)
    const call = vi.spyOn(ompClient, 'call').mockResolvedValue({
      messages: [agentMessage('user', 'tail')],
      totalMessages: 400,
      nextCursor: 'c9'
    } as never)

    const { statusCode, json } = await getHistory('/api/chat/history?cursor=c0&limit=256')
    expect(statusCode).toBe(200)
    expect(json).toEqual({
      success: true,
      source: 'omp',
      messages: [{ role: 'user', content: 'tail' }],
      totalMessages: 400,
      nextCursor: 'c9'
    })
    // One page only - the paged call never walks the rest of the transcript.
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('get_messages_page', { cursor: 'c0', limit: 256 })
  })

  it('returns an empty paged response when OMP is not running', async () => {
    vi.spyOn(ompClient, 'running', 'get').mockReturnValue(false)
    const call = vi.spyOn(ompClient, 'call')

    const { statusCode, json } = await getHistory('/api/chat/history?limit=10')
    expect(statusCode).toBe(200)
    expect(json).toEqual({ success: true, source: 'local', messages: [], totalMessages: 0 })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range limit before touching OMP', async () => {
    vi.spyOn(ompClient, 'running', 'get').mockReturnValue(true)
    const call = vi.spyOn(ompClient, 'call')

    const { statusCode } = await getHistory('/api/chat/history?limit=999')
    expect(statusCode).toBe(400)
    expect(call).not.toHaveBeenCalled()
  })

  it('answers 409 while the session is busy paging', async () => {
    vi.spyOn(ompClient, 'running', 'get').mockReturnValue(true)
    vi.spyOn(ompClient, 'call').mockRejectedValue(new Error('session_busy: cannot page while streaming'))

    const { statusCode } = await getHistory('/api/chat/history?limit=10')
    expect(statusCode).toBe(409)
  })
})

describe('direct chat SSE', () => {
  it('preserves UTF-8 text split inside a multibyte character', async () => {
    const bytes = frame({ type: 'content_block_delta', delta: { text: '你好' } })
    const split = bytes.indexOf(Buffer.from('你')) + 1
    const frames = await stream([bytes.subarray(0, split), bytes.subarray(split)])
    expect(frames.filter((item) => item.type === 'delta')).toEqual([{ type: 'delta', text: '你好' }])
  })

  it('reports each token once when Anthropic sends cumulative partial usage', async () => {
    const frames = await stream([
      frame({ type: 'message_start', message: { usage: { input_tokens: 123, output_tokens: 1 } } }),
      frame({ type: 'message_delta', usage: { output_tokens: 42 } })
    ])
    const total = frames.filter((item) => item.type === 'usage').reduce(
      (sum, item) => ({ input: sum.input + item.inputTokens, output: sum.output + item.outputTokens }),
      { input: 0, output: 0 }
    )
    expect(total).toEqual({ input: 123, output: 42 })
  })

  it('does not drop usage attached to a text delta', async () => {
    const frames = await stream([frame({ choices: [{ delta: { content: 'hello' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })])
    expect(frames).toContainEqual({ type: 'delta', text: 'hello' })
    expect(frames).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 3 })
  })

  it.each([
    { type: 'error', error: { type: 'overloaded_error', message: 'provider overloaded' } },
    { type: 'response.failed', response: { error: { message: 'provider overloaded' } } }
  ])('reports a provider error inside HTTP 200 instead of successful completion', async (payload) => {
    const frames = await stream([frame(payload)])
    expect(frames).toContainEqual({ type: 'error', message: 'provider overloaded' })
    expect(frames.some((item) => item.type === 'done')).toBe(false)
  })

  it('rejects a second turn without overwriting the active abort controller', async () => {
    appState.thirdParty = { baseUrl: 'http://unused.invalid', models: ['test'] }
    appState.route = { group: '第三方', modelId: 'test', apiType: 'chat', thinkingLevel: null, routeKey: 'test', tokenName: 'test', capabilityLabel: 'test', effectiveContext: 100_000 }
    appState.generationInFlight = true
    const abort = new AbortController()
    appState.currentAbort = abort
    const app = Fastify()
    registerChatRoutes(app)
    try {
      const response = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { messages: [{ role: 'user', content: 'second' }] } })
      expect(response.statusCode).toBe(409)
      await app.inject({ method: 'POST', url: '/api/chat/abort' })
      expect(abort.signal.aborted).toBe(true)
      expect(appState.generationInFlight).toBe(true)
    } finally {
      await app.close()
    }
  })
})
