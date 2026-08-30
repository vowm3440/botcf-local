import { describe, expect, it } from 'vitest'
import {
  appendAssistantDelta,
  appendAssistantReasoning,
  appendAssistantText,
  appendNotice,
  applyToolFrame,
  attachChangedFiles,
  growVisibleText,
  type ChatMessage
} from '../src/chat/messages'

/** Stream frames arrive as text, tool updates and an end-of-turn summary, all
 *  landing on "the message the assistant is currently writing" — which may not
 *  exist yet when a turn opens with a tool call instead of a sentence. */

const userTurn: ChatMessage[] = [{ role: 'user', content: '改一下登录页' }]

describe('appendAssistantText', () => {
  it('opens an assistant message when the transcript ends with the user', () => {
    const next = appendAssistantText(userTurn, (content) => content + '好的')
    expect(next).toHaveLength(2)
    expect(next[1]).toEqual({ role: 'assistant', content: '好的' })
    expect(userTurn).toHaveLength(1)
  })

  it('appends to the open assistant message', () => {
    const opened: ChatMessage[] = [...userTurn, { role: 'assistant', content: '好' }]
    expect(appendAssistantText(opened, (content) => content + '的').at(-1)?.content).toBe('好的')
  })

  it('keeps the tool calls already on that message', () => {
    const opened: ChatMessage[] = [
      { role: 'assistant', content: '', tools: [{ id: 't1', name: 'Edit', status: 'done' }] }
    ]
    expect(appendAssistantText(opened, () => '完成').at(-1)?.tools).toHaveLength(1)
  })
})

describe('applyToolFrame', () => {
  it('opens an assistant message for a turn that starts with a tool call', () => {
    const next = applyToolFrame(userTurn, { id: 't1', name: 'Edit', phase: 'start', path: 'app/a.ts' })
    expect(next).toHaveLength(2)
    expect(next[1].tools).toEqual([
      { id: 't1', name: 'Edit', status: 'running', args: undefined, intent: undefined, path: 'app/a.ts', output: undefined, diff: undefined }
    ])
  })

  it('upserts by call id rather than appending a second card', () => {
    const started = applyToolFrame(userTurn, { id: 't1', name: 'Edit', phase: 'start', args: { path: 'a.ts' } })
    const ended = applyToolFrame(started, { id: 't1', name: 'Edit', phase: 'end', output: 'ok' })
    const tools = ended.at(-1)?.tools ?? []
    expect(tools).toHaveLength(1)
    expect(tools[0].status).toBe('done')
    // The end frame carries no args; the ones from the start frame must survive.
    expect(tools[0].args).toEqual({ path: 'a.ts' })
    expect(tools[0].output).toBe('ok')
  })

  it('tracks several concurrent calls in arrival order', () => {
    let messages = applyToolFrame(userTurn, { id: 't1', name: 'Read', phase: 'start' })
    messages = applyToolFrame(messages, { id: 't2', name: 'Edit', phase: 'start' })
    messages = applyToolFrame(messages, { id: 't1', name: 'Read', phase: 'end' })
    const tools = messages.at(-1)?.tools ?? []
    expect(tools.map((tool) => tool.id)).toEqual(['t1', 't2'])
    expect(tools.map((tool) => tool.status)).toEqual(['done', 'running'])
  })

  it('marks a failed call as an error', () => {
    const next = applyToolFrame(userTurn, { id: 't1', name: 'Edit', phase: 'end', isError: true })
    expect(next.at(-1)?.tools?.[0].status).toBe('error')
  })

  it('does not mutate the message it updates', () => {
    const started = applyToolFrame(userTurn, { id: 't1', name: 'Edit', phase: 'start' })
    const before = started.at(-1)
    applyToolFrame(started, { id: 't1', name: 'Edit', phase: 'end' })
    expect(before?.tools?.[0].status).toBe('running')
  })
})

describe('attachChangedFiles', () => {
  const changed = [{ path: 'app/a.ts', tools: ['Edit'], lastToolCallId: 't1', hasDiff: true, isError: false }]

  it('attaches to the turn that produced them, not to the end of the list', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '第一轮' },
      { role: 'user', content: '再来' },
      { role: 'assistant', content: '第二轮' }
    ]
    const next = attachChangedFiles(messages, changed)
    expect(next[2].changedFiles).toEqual(changed)
    expect(next[0].changedFiles).toBeUndefined()
  })

  it('is a no-op when the transcript has no assistant message', () => {
    expect(attachChangedFiles(userTurn, changed)).toEqual(userTurn)
  })
})

/** The regression this pins down: an agent step is thinking, then a visible text
 *  part that is *only* "\n\n", then a tool call. Concatenating those verbatim grew
 *  one blank paragraph per step, so a multi-step turn opened with a tall empty gap
 *  before any sentence arrived. */
describe('growVisibleText', () => {
  it('drops whitespace that would be the whole message so far', () => {
    expect(growVisibleText('', '\n\n')).toBe('')
    expect(growVisibleText('', '  \n \t ')).toBe('')
  })

  it('collapses the blank padding between two real paragraphs', () => {
    expect(growVisibleText('第一段', '\n\n')).toBe('第一段\n\n')
    expect(growVisibleText('第一段\n\n', '\n\n')).toBe('第一段\n\n')
    expect(growVisibleText('第一段\n\n', '第二段')).toBe('第一段\n\n第二段')
  })

  it('keeps a paragraph break the model actually wrote', () => {
    expect(growVisibleText('标题', '\n\n正文')).toBe('标题\n\n正文')
  })

  it('never touches non-blank text', () => {
    expect(growVisibleText('a', 'b')).toBe('ab')
    expect(growVisibleText('```\n', 'code\n')).toBe('```\ncode\n')
  })

  it('preserves a single leading newline inside real content', () => {
    expect(growVisibleText('列表:', '\n- 一')).toBe('列表:\n- 一')
  })
})

describe('appendAssistantDelta', () => {
  it('a whole turn of blank agent-step padding leaves no gap at all', () => {
    // Four steps of thinking → "\n\n" → tool call, then the real answer.
    let messages: ChatMessage[] = [...userTurn]
    for (let step = 0; step < 4; step++) messages = appendAssistantDelta(messages, '\n\n')
    expect(messages.at(-1)?.content).toBe('')
    messages = appendAssistantDelta(messages, '改好了')
    expect(messages.at(-1)?.content).toBe('改好了')
  })

  it('opens an assistant message even for a padding-only delta', () => {
    expect(appendAssistantDelta(userTurn, '\n\n')).toHaveLength(2)
  })

  it('does not mutate the transcript it grows', () => {
    const opened: ChatMessage[] = [...userTurn, { role: 'assistant', content: '好' }]
    appendAssistantDelta(opened, '的')
    expect(opened[1].content).toBe('好')
  })
})

describe('appendAssistantReasoning', () => {
  it('accumulates thinking separately from the answer', () => {
    let messages = appendAssistantReasoning(userTurn, '先读文件')
    messages = appendAssistantReasoning(messages, ',再改')
    messages = appendAssistantDelta(messages, '改好了')
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: '改好了', reasoning: '先读文件,再改' })
  })

  it('keeps thinking verbatim — it is shown as the model wrote it', () => {
    expect(appendAssistantReasoning(userTurn, '\n\nhmm').at(-1)?.reasoning).toBe('\n\nhmm')
  })

  it('lands on the message a tool call already opened', () => {
    const withTool = applyToolFrame(userTurn, { id: 't1', name: 'Read', phase: 'start' })
    const next = appendAssistantReasoning(withTool, '想一下')
    expect(next).toHaveLength(2)
    expect(next[1].tools).toHaveLength(1)
    expect(next[1].reasoning).toBe('想一下')
  })
})

describe('appendNotice', () => {
  it('records run chrome on the open assistant message', () => {
    const next = appendNotice(userTurn, { level: 'warn', text: '回答被截断' })
    expect(next).toHaveLength(2)
    expect(next[1].notices).toEqual([{ level: 'warn', text: '回答被截断' }])
  })

  it('folds a repeated line instead of printing it ten times', () => {
    let messages = appendNotice(userTurn, { level: 'warn', text: '正在重试' })
    messages = appendNotice(messages, { level: 'warn', text: '正在重试' })
    expect(messages.at(-1)?.notices).toHaveLength(1)
  })

  it('keeps a different line that follows a repeat', () => {
    let messages = appendNotice(userTurn, { level: 'info', text: '正在压缩上下文…' })
    messages = appendNotice(messages, { level: 'info', text: '正在压缩上下文…' })
    messages = appendNotice(messages, { level: 'info', text: '上下文已压缩' })
    expect(messages.at(-1)?.notices?.map((n) => n.text)).toEqual(['正在压缩上下文…', '上下文已压缩'])
  })

  it('does not mutate the message it annotates', () => {
    const opened = appendNotice(userTurn, { level: 'info', text: '一' })
    appendNotice(opened, { level: 'info', text: '二' })
    expect(opened.at(-1)?.notices).toHaveLength(1)
  })
})
