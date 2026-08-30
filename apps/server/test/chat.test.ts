import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  buildUpstreamRequest,
  extractAssistantDelta,
  extractDelta,
  normalizeAgentMessage,
  normalizeSessionNotice,
  extractSessionUsage,
  normalizeToolEvent,
  parseSessionSummary,
  terminalOutcome
} from '../src/routes/chat.js'
import { parseContextLimit } from '../src/proxy/credentialProxy.js'
import { EMPTY_WORKSPACE, addRoot, workspaceDisplayPath } from '../src/workspace/model.js'

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

describe('normalizeToolEvent', () => {  it('keeps structured call arguments, intent and the extracted file path', () => {
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

  it('normalizes the path with the supplied workspace resolver so the UI can open it', () => {
    const workdir = path.resolve('proj')
    const added = addRoot(EMPTY_WORKSPACE, { path: workdir })
    if (!added.ok) throw new Error(added.error)
    expect(normalizeToolEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-4',
      toolName: 'edit',
      args: { path: path.join(workdir, 'src', 'app.ts') }
    }, (raw) => workspaceDisplayPath(added.workspace, raw))).toMatchObject({ path: `${added.root.name}/src/app.ts` })
  })

  it('carries the target path on end frames so a missed start frame still resolves', () => {
    expect(normalizeToolEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-5',
      toolName: 'write',
      args: { file_path: 'notes.md' },
      result: { content: [{ type: 'text', text: 'ok' }] }
    })).toMatchObject({ phase: 'end', path: 'notes.md', args: { file_path: 'notes.md' } })
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

  it('clamps xhigh/max to high for direct responses calls', () => {
    expect(buildUpstreamRequest('responses', 'gpt-5.6-terra', msgs, 'xhigh', 8192).body.reasoning).toEqual({ effort: 'high' })
    expect(buildUpstreamRequest('responses', 'gpt-5.6-terra', msgs, 'max', 8192).body.reasoning).toEqual({ effort: 'high' })
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

/** Thinking used to be dropped on the floor, which is what made a reasoning turn
 *  render as a blank gap: the only *visible* text such a step emits is "\n\n". */
describe('extractAssistantDelta', () => {
  it('keeps documented text deltas as text', () => {
    expect(extractAssistantDelta({ type: 'text_delta', delta: 'hello' })).toEqual({ kind: 'text', text: 'hello' })
  })

  it('classifies thinking and reasoning deltas separately from the answer', () => {
    expect(extractAssistantDelta({ type: 'thinking_delta', delta: 'let me' })).toEqual({ kind: 'reasoning', text: 'let me' })
    expect(extractAssistantDelta({ type: 'reasoning_delta', delta: 'think' })).toEqual({ kind: 'reasoning', text: 'think' })
    expect(extractAssistantDelta({ type: 'thinking', thinking: 'about it' })).toEqual({ kind: 'reasoning', text: 'about it' })
  })

  it('keeps whitespace-only text deltas — the transcript decides what to do with them', () => {
    expect(extractAssistantDelta({ type: 'text_delta', delta: '\n\n' })).toEqual({ kind: 'text', text: '\n\n' })
  })

  it('ignores tool-call deltas and malformed frames', () => {
    expect(extractAssistantDelta({ type: 'toolcall_delta', delta: '{"a":' })).toBeNull()
    expect(extractAssistantDelta({ type: 'text_delta' })).toBeNull()
    expect(extractAssistantDelta({ type: 'text_delta', delta: '' })).toBeNull()
    expect(extractAssistantDelta(undefined)).toBeNull()
  })
})

describe('normalizeSessionNotice', () => {
  it('narrates the lifecycle events the terminal UI shows', () => {
    expect(normalizeSessionNotice({ type: 'auto_compaction_start' })).toEqual({ type: 'notice', level: 'info', text: '正在压缩上下文…' })
    expect(normalizeSessionNotice({ type: 'auto_compaction_end' })?.level).toBe('info')
    expect(normalizeSessionNotice({ type: 'retry_fallback_succeeded' })?.level).toBe('info')
  })

  it('marks failure-shaped events as warnings and carries their detail', () => {
    const retry = normalizeSessionNotice({ type: 'auto_retry_start', attempt: 2, reason: '502 upstream  error' })
    expect(retry?.level).toBe('warn')
    expect(retry?.text).toBe('上游失败,正在重试 (第 2 次):502 upstream error')
    expect(normalizeSessionNotice({ type: 'retry_fallback_applied', modelId: 'gpt-5.4' })?.text).toContain('gpt-5.4')
  })

  it('passes runtime notices through with their own severity', () => {
    expect(normalizeSessionNotice({ type: 'notice', message: '磁盘将满', level: 'warning' })?.level).toBe('warn')
    expect(normalizeSessionNotice({ type: 'notice', message: '已加载扩展' })?.level).toBe('info')
  })

  it('stays silent for frames with nothing to say', () => {
    expect(normalizeSessionNotice({ type: 'notice' })).toBeNull()
    expect(normalizeSessionNotice({ type: 'model_changed' })).toBeNull()
    expect(normalizeSessionNotice({ type: 'turn_start' })).toBeNull()
    expect(normalizeSessionNotice({ type: 'message_update' })).toBeNull()
  })
})

/** The two quiet failures that both rendered as a blank "助手:": a turn that
 *  spent its whole output budget thinking, and a model call that failed outright
 *  (a 409 route mismatch looked exactly like a model with nothing to say). */
describe('terminalOutcome', () => {
  it('warns when the last assistant message hit the output ceiling', () => {
    expect(terminalOutcome({
      type: 'agent_end',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '看看这个项目' }] },
        { role: 'assistant', stopReason: 'toolUse', content: [] },
        { role: 'assistant', stopReason: 'length', content: [{ type: 'thinking', thinking: '…' }] }
      ]
    })).toEqual({ kind: 'length' })
  })

  it('reports a failed model call with its status and message', () => {
    expect(terminalOutcome({
      type: 'agent_end',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          stopReason: 'error',
          errorStatus: 409,
          errorMessage: '当前路由是 chat 接口,收到的却是 messages 请求',
          content: []
        }
      ]
    })).toEqual({
      kind: 'error',
      status: 409,
      message: '当前路由是 chat 接口,收到的却是 messages 请求'
    })
  })

  it('accepts a nested error object and drifting field names', () => {
    expect(terminalOutcome({
      messages: [{ role: 'assistant', stop_reason: 'failed', error: { message: 'upstream 502', statusCode: 502 } }]
    })).toEqual({ kind: 'error', status: 502, message: 'upstream 502' })
  })

  it('still reports an error when the turn produced no assistant message', () => {
    expect(terminalOutcome({ type: 'agent_end', stopReason: 'error', errorMessage: '进程无响应', messages: [{ role: 'user' }] }))
      .toEqual({ kind: 'error', status: null, message: '进程无响应' })
  })

  it('never leaves an error without a reason to show', () => {
    expect(terminalOutcome({ messages: [{ role: 'assistant', stopReason: 'error' }] })).toEqual({
      kind: 'error',
      status: null,
      message: '模型调用失败,运行时没有给出原因'
    })
  })

  it('classifies an interrupted turn as aborted, not as an error', () => {
    expect(terminalOutcome({ messages: [{ role: 'assistant', stopReason: 'aborted' }] })).toEqual({ kind: 'aborted' })
    expect(terminalOutcome({ messages: [{ role: 'assistant', stopReason: 'cancelled' }] })).toEqual({ kind: 'aborted' })
  })

  it('says nothing for a turn that ended normally', () => {
    expect(terminalOutcome({ messages: [{ role: 'assistant', stopReason: 'endTurn' }] })).toEqual({ kind: 'normal' })
    expect(terminalOutcome({ messages: [{ role: 'assistant', stopReason: 'toolUse' }] })).toEqual({ kind: 'normal' })
  })

  it('only inspects the final assistant message', () => {
    expect(
      terminalOutcome({
        messages: [
          { role: 'assistant', stopReason: 'length' },
          { role: 'assistant', stopReason: 'endTurn' }
        ]
      })
    ).toEqual({ kind: 'normal' })
  })

  it('tolerates frames without a message array', () => {
    expect(terminalOutcome({ type: 'agent_end' })).toEqual({ kind: 'normal' })
    expect(terminalOutcome({ messages: [] })).toEqual({ kind: 'normal' })
    expect(terminalOutcome({ messages: [{ role: 'user' }] })).toEqual({ kind: 'normal' })
  })
})
