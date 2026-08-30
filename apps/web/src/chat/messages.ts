import type { ChangedFileInfo } from '../api'

/** The chat transcript as a value, plus the pure reducers that grow it.
 *
 *  Streaming hands over fragments out of order: text deltas, thinking deltas, run
 *  chrome (compaction, retries), tool frames keyed by a call id, then an
 *  authoritative changed-files summary at the end of the turn. All of them land on
 *  "the last assistant message", creating it when the turn opened with a tool call
 *  or a thought instead of text. That rule is easy to get subtly wrong and
 *  impossible to see in a screenshot, so it lives here, pure and tested — as does
 *  `growVisibleText`, which is the difference between a readable turn and a wall of
 *  blank lines. */

export type ToolStatus = 'running' | 'done' | 'error'

export interface ToolCall {
  id: string
  name: string
  status: ToolStatus
  args?: unknown
  intent?: string
  path?: string
  output?: string
  diff?: string
}

/** One line of run chrome: a compaction, a retry, an auto-approval. */
export interface TranscriptNotice {
  level: 'info' | 'warn'
  text: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** The model's thinking for this turn, concatenated. Shown collapsed. */
  reasoning?: string
  tools?: ToolCall[]
  notices?: TranscriptNotice[]
  changedFiles?: ChangedFileInfo[]
}

/** One `type: 'tool'` stream frame, narrowed to the fields it must carry. */
export interface ToolFrame {
  id: string
  name: string
  phase: 'start' | 'update' | 'end'
  isError?: boolean
  args?: unknown
  intent?: string
  path?: string
  output?: string
  diff?: string
}

/** Index of the message the current turn is writing into, or -1 when the turn has
 *  not opened an assistant message yet. */
function lastAssistantIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant') return index
  }
  return -1
}

/** Growing a message's visible text, one delta at a time.
 *
 *  An agent turn alternates thinking, a blank visible part, and a tool call: the
 *  model's *visible* output for such a step is literally "\n\n". Concatenating
 *  those verbatim is what produced a tall empty gap in the transcript — one blank
 *  paragraph per step, before any real sentence arrives.
 *
 *  So whitespace never stands on its own here: it is dropped while the message
 *  has nothing visible yet, and a run of blank lines between two real paragraphs
 *  collapses to the one blank line that separates them. Text the model actually
 *  wrote is never touched. */
export function growVisibleText(existing: string, delta: string): string {
  if (existing === '' && delta.trim() === '') return ''
  return (existing + delta).replace(/\n{3,}/g, '\n\n')
}

export function appendAssistantText(messages: readonly ChatMessage[], update: (previous: string) => string): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') {
    return [...messages, { role: 'assistant', content: update('') }]
  }
  return [...messages.slice(0, -1), { ...last, content: update(last.content) }]
}

/** Append a text delta to the open assistant message, collapsing the blank
 *  padding an agent turn emits around its tool calls. */
export function appendAssistantDelta(messages: readonly ChatMessage[], delta: string): ChatMessage[] {
  return appendAssistantText(messages, (content) => growVisibleText(content, delta))
}

/** Append a thinking delta. Reasoning accumulates on the same message as the
 *  answer, so a turn reads as one block whichever arrived first. */
export function appendAssistantReasoning(messages: readonly ChatMessage[], delta: string): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') {
    return [...messages, { role: 'assistant', content: '', reasoning: delta }]
  }
  return [...messages.slice(0, -1), { ...last, reasoning: (last.reasoning ?? '') + delta }]
}

/** Record one line of run chrome on the open assistant message. Consecutive
 *  duplicates fold: a retry loop should not print the same line ten times. */
export function appendNotice(messages: readonly ChatMessage[], notice: TranscriptNotice): ChatMessage[] {
  const opened =
    messages[messages.length - 1]?.role === 'assistant'
      ? [...messages]
      : [...messages, { role: 'assistant' as const, content: '' }]
  const index = opened.length - 1
  const assistant = opened[index]
  const notices = assistant.notices ?? []
  if (notices[notices.length - 1]?.text === notice.text) return opened
  opened[index] = { ...assistant, notices: [...notices, notice] }
  return opened
}

/** Upsert a tool call on the open assistant message, by call id. */
export function applyToolFrame(messages: readonly ChatMessage[], frame: ToolFrame): ChatMessage[] {
  const opened =
    messages[messages.length - 1]?.role === 'assistant'
      ? [...messages]
      : [...messages, { role: 'assistant' as const, content: '', tools: [] }]
  const index = opened.length - 1
  const assistant = opened[index]
  const tools = [...(assistant.tools ?? [])]
  const existingIndex = tools.findIndex((tool) => tool.id === frame.id)
  const existing: ToolCall =
    existingIndex >= 0 ? tools[existingIndex] : { id: frame.id, name: frame.name, status: 'running' }
  const next: ToolCall = {
    ...existing,
    name: frame.name,
    status: frame.phase === 'end' ? (frame.isError ? 'error' : 'done') : 'running',
    args: frame.args ?? existing.args,
    intent: frame.intent ?? existing.intent,
    path: frame.path ?? existing.path,
    output: frame.output ?? existing.output,
    diff: frame.diff ?? existing.diff
  }
  if (existingIndex >= 0) tools[existingIndex] = next
  else tools.push(next)
  opened[index] = { ...assistant, tools }
  return opened
}

/** Attach a turn's authoritative changed-files summary to that turn's message. */
export function attachChangedFiles(messages: readonly ChatMessage[], files: readonly ChangedFileInfo[]): ChatMessage[] {
  const index = lastAssistantIndex(messages)
  if (index < 0) return [...messages]
  const copy = [...messages]
  copy[index] = { ...copy[index], changedFiles: [...files] }
  return copy
}
