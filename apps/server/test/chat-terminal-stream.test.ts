import type { FastifyReply } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { diagnosticsCenter } from '../src/diagnostics/center.js'
import {
  TRUNCATION_NOTICE,
  isTerminalAgentEnd,
  reportTerminalOutcome,
  terminalOutcome
} from '../src/routes/chat.js'

/** What a terminal `agent_end` actually produces.
 *
 *  chat.test.ts covers the classifier: which stop reason means error, truncation or
 *  abort. That is not what P1-002 was — the failure was that a failed model call
 *  reached the user as an *empty assistant message*, because nothing downstream of
 *  the classification was wired. So this test drives the two lines the stream runs
 *  for such a frame and asserts both observable effects: the SSE frame the browser
 *  receives and the entry the diagnostics center keeps, secrets redacted in both. */

function recorder(): { reply: FastifyReply; frames: () => Array<Record<string, unknown>> } {
  const chunks: string[] = []
  const reply = {
    raw: {
      write: (chunk: string): boolean => {
        chunks.push(chunk)
        return true
      }
    }
  } as unknown as FastifyReply
  return {
    reply,
    frames: () =>
      chunks.map((chunk) => {
        // The SSE framing itself is part of the contract: anything but
        // `data: <json>\n\n` is not an event the browser would parse.
        expect(chunk.startsWith('data: ')).toBe(true)
        expect(chunk.endsWith('\n\n')).toBe(true)
        return JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>
      })
  }
}

/** Exactly what streamViaOmp does with an OMP session event. */
function handle(frame: Record<string, unknown>, reply: FastifyReply): boolean {
  if (!isTerminalAgentEnd(frame)) return false
  reportTerminalOutcome(reply, terminalOutcome(frame))
  return true
}

function agentDiagnostics() {
  return diagnosticsCenter.list({ origin: 'agent' })
}

beforeEach(() => {
  diagnosticsCenter.clear()
})

describe('terminal agent_end → SSE + diagnostics', () => {
  it('turns a failed model call into an error frame and a diagnostics entry', () => {
    const { reply, frames } = recorder()

    expect(handle({
      type: 'agent_end',
      isTerminal: true,
      messages: [
        { role: 'user' },
        { role: 'assistant', stopReason: 'error', errorMessage: '上游拒绝: invalid model for this key', errorStatus: 409 }
      ]
    }, reply)).toBe(true)

    // The browser gets a real error frame — never an empty assistant message.
    expect(frames()).toEqual([
      { type: 'error', message: '模型调用失败 (HTTP 409): 上游拒绝: invalid model for this key' }
    ])
    // …and the same text is in the errors panel, where it survives scrolling away.
    const entries = agentDiagnostics()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      origin: 'agent',
      source: '模型调用',
      severity: 'error',
      tool: 'omp',
      message: '模型调用失败 (HTTP 409): 上游拒绝: invalid model for this key'
    })
  })

  it('redacts the credentials an upstream error echoes back, in both', () => {
    const { reply, frames } = recorder()

    handle({
      type: 'agent_end',
      stopReason: 'error',
      errorMessage: 'request failed {"authorization":"Bearer sk-live-abcdef1234567890"} password=hunter2'
    }, reply)

    const [frame] = frames()
    const message = String(frame.message)
    expect(message).not.toContain('abcdef1234567890')
    expect(message).not.toContain('hunter2')
    expect(message).toContain('***')
    // A leak that only the SSE frame is protected from is still a leak: the
    // diagnostics entry outlives the stream and is what gets copied into a report.
    expect(agentDiagnostics()[0].message).toBe(message)
  })

  it('keeps the reported failure bounded', () => {
    const { reply, frames } = recorder()

    handle({ type: 'agent_end', stopReason: 'error', errorMessage: 'x'.repeat(5_000) }, reply)

    const message = String(frames()[0].message)
    expect(message).toContain('x'.repeat(1_000))
    expect(message).not.toContain('x'.repeat(1_001))
    expect(agentDiagnostics()[0].message).toHaveLength(1_000)
  })

  it('falls back to a stated reason when the runtime gives none', () => {
    const { reply, frames } = recorder()

    handle({ type: 'agent_end', stopReason: 'error' }, reply)

    // No status, no text: still an error the user can see, not silence.
    expect(frames()).toEqual([{ type: 'error', message: '模型调用失败: 模型调用失败,运行时没有给出原因' }])
    expect(agentDiagnostics()).toHaveLength(1)
  })

  it('warns about a truncated answer instead of erroring', () => {
    const { reply, frames } = recorder()

    handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'length' }] }, reply)

    expect(frames()).toEqual([{ type: 'notice', level: 'warn', text: TRUNCATION_NOTICE }])
    expect(agentDiagnostics()).toMatchObject([{ severity: 'warning', source: '模型输出', message: TRUNCATION_NOTICE }])
  })

  it('reports a user abort without filing a problem', () => {
    const { reply, frames } = recorder()

    handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] }, reply)

    expect(frames()).toEqual([{ type: 'aborted' }])
    // Stopping the agent yourself is not a fault, and the errors panel must not
    // fill up with entries for it.
    expect(agentDiagnostics()).toEqual([])
  })

  it('says nothing at all about a turn that ended normally', () => {
    const { reply, frames } = recorder()

    handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'endTurn' }] }, reply)

    expect(frames()).toEqual([])
    expect(agentDiagnostics()).toEqual([])
  })

  it('ignores a non-terminal agent_end, whatever it carries', () => {
    const { reply, frames } = recorder()

    // OMP emits agent_end per intermediate step too; reporting one of those would
    // end the turn early and blame the run for a failure it recovered from.
    expect(handle({
      type: 'agent_end',
      isTerminal: false,
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'transient' }]
    }, reply)).toBe(false)

    expect(frames()).toEqual([])
    expect(agentDiagnostics()).toEqual([])
  })

  it('collapses the same failure repeated across turns into one counted entry', () => {
    const { reply } = recorder()
    const frame = { type: 'agent_end', stopReason: 'error', errorMessage: '上游 502' }

    handle({ ...frame }, reply)
    handle({ ...frame }, reply)

    expect(agentDiagnostics()).toHaveLength(1)
    expect(agentDiagnostics()[0].count).toBe(2)
  })
})
