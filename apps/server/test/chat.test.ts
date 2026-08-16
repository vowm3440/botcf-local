import { describe, expect, it } from 'vitest'
import { buildUpstreamRequest, extractDelta, normalizeAgentMessage, extractSessionUsage, normalizeToolEvent, parseSessionSummary } from '../src/routes/chat.js'
import { parseContextLimit } from '../src/proxy/credentialProxy.js'

describe('extractSessionUsage', () => {
  it('reads snake_case top-level fields', () => {
    expect(extractSessionUsage({ input_tokens: 100, output_tokens: 50 })).toEqual({ input: 100, output: 50 })
  })

  it('reads camelCase nested usage objects', () => {
    expect(extractSessionUsage({ usage: { inputTokens: 7, outputTokens: 3 } })).toEqual({ input: 7, output: 3 })
  })

  it('reads OMP SessionStats token totals', () => {
    expect(extractSessionUsage({ tokens: { input: 420, output: 84, total: 504 } })).toEqual({ input: 420, output: 84 })
  })

  it('returns null when nothing token-like exists', () => {
    expect(extractSessionUsage({ messageCount: 4 })).toBeNull()
  })
})

describe('normalizeToolEvent', () => {
  it('keeps structured call arguments, intent and the extracted file path', () => {
    expect(normalizeToolEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'edit',
      args: { path: 'src/app.ts' },
      intent: 'Updating app'
    })).toEqual({
      type: 'tool',
      phase: 'start',
      id: 'call-1',
      name: 'edit',
      args: { path: 'src/app.ts' },
      intent: 'Updating app',
      path: 'src/app.ts'
    })
  })

  it('extracts drifting file path field names on start frames', () => {
    expect(normalizeToolEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-2',
      toolName: 'write',
      args: { file_path: 'notes.md', content: 'x' }
    })).toMatchObject({ phase: 'start', name: 'write', path: 'notes.md' })
  })

  it('omits the path field when arguments carry none', () => {
    expect(normalizeToolEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-3',
      toolName: 'bash',
      args: { command: 'ls' }
    })).not.toHaveProperty('path')
  })

  it('extracts output and diff details from a completed call', () => {
    expect(normalizeToolEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'edit',
      result: {
        content: [{ type: 'text', text: 'Applied patch' }],
        details: { diff: '-old\\n+new' }
      }
    })).toEqual({
      type: 'tool',
      phase: 'end',
      id: 'call-1',
      name: 'edit',
      output: 'Applied patch',
      diff: '-old\\n+new',
      isError: false
    })
  })
})

describe('parseSessionSummary', () => {
  it('uses the saved title and first user prompt', () => {
    const text = [
      JSON.stringify({ type: 'title', title: 'Repair parser' }),
      JSON.stringify({ type: 'session', id: 'session-1', timestamp: '2026-08-15T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Fix the parser edge case' }] } })
    ].join('\n')
    expect(parseSessionSummary('C:/sessions/a.jsonl', text, 1234)).toEqual({
      path: 'C:/sessions/a.jsonl',
      id: 'session-1',
      title: 'Repair parser',
      preview: 'Fix the parser edge case',
      createdAt: Date.parse('2026-08-15T00:00:00.000Z'),
      updatedAt: 1234
    })
  })
})

describe('normalizeAgentMessage', () => {
  it('keeps plain string user/assistant messages', () => {
    expect(normalizeAgentMessage({ role: 'user', content: 'hi' })).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('joins text parts and drops thinking/toolcall parts', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Hello ' },
        { type: 'toolCall', id: 't1' },
        { type: 'text', text: 'world' }
      ]
    }
    expect(normalizeAgentMessage(msg)).toEqual([{ role: 'assistant', content: 'Hello world' }])
  })

  it('drops tool-result and empty messages', () => {
    expect(normalizeAgentMessage({ role: 'toolResult', content: 'x' })).toEqual([])
    expect(normalizeAgentMessage({ role: 'assistant', content: [] })).toEqual([])
    expect(normalizeAgentMessage({ role: 'user', content: '   ' })).toEqual([])
  })
})

describe('buildUpstreamRequest', () => {
  const msgs = [
    { role: 'system' as const, content: 'be brief' },
    { role: 'user' as const, content: 'hi' }
  ]

  it('responses route uses /v1/responses with reasoning effort', () => {
    const { path, body } = buildUpstreamRequest('responses', 'gpt-5.6-terra', msgs, 'high', 8192)
    expect(path).toBe('/v1/responses')
    expect(body.model).toBe('gpt-5.6-terra')
    expect(body.reasoning).toEqual({ effort: 'high' })
    expect(body.stream).toBe(true)
  })

  it('messages route hoists system prompt and sets max_tokens', () => {
    const { path, body } = buildUpstreamRequest('messages', 'claude-x', msgs, null, 4096)
    expect(path).toBe('/v1/messages')
    expect(body.system).toBe('be brief')
    expect(body.max_tokens).toBe(4096)
    expect((body.messages as unknown[]).length).toBe(1)
  })

  it('chat route requests usage in stream', () => {
    const { path, body } = buildUpstreamRequest('chat', 'gemini-2.5-pro', msgs, null, 8192)
    expect(path).toBe('/v1/chat/completions')
    expect(body.stream_options).toEqual({ include_usage: true })
  })
})

describe('extractDelta', () => {
  it('parses openai chat deltas', () => {
    expect(extractDelta({ choices: [{ delta: { content: 'he' } }] })).toEqual({ text: 'he' })
  })

  it('parses responses output_text deltas', () => {
    expect(extractDelta({ type: 'response.output_text.delta', delta: 'llo' })).toEqual({ text: 'llo' })
  })

  it('parses anthropic content_block_delta', () => {
    expect(extractDelta({ type: 'content_block_delta', delta: { text: '!' } })).toEqual({ text: '!' })
  })

  it('parses usage from all three shapes', () => {
    expect(extractDelta({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(extractDelta({ response: { usage: { input_tokens: 7, output_tokens: 3 } } })).toEqual({ inputTokens: 7, outputTokens: 3 })
    expect(extractDelta({ message: { usage: { input_tokens: 1 } } })).toEqual({ inputTokens: 1, outputTokens: undefined })
  })
})

describe('parseContextLimit', () => {
  it('extracts the documented limit from upstream errors', () => {
    expect(parseContextLimit("This model's maximum context length is 200000 tokens.")).toBe(200000)
    expect(parseContextLimit('random error')).toBeUndefined()
  })
})
