import { describe, expect, it } from 'vitest'
import { autoApprovalLabel, parseAccessMode, shouldAutoApprove, DIALOG_METHODS } from '../src/omp/access.js'

/** "Full access" here means exactly one thing: the host answers OMP's `confirm`
 *  dialogs instead of the user. OMP's RPC protocol has no permission command, so
 *  the predicate below is the whole mechanism — and it has to be pure, because the
 *  auto-approver and the SSE forwarder both evaluate it on the same frame and must
 *  reach the same answer without sharing state. */

const confirmFrame = {
  type: 'extension_ui_request',
  id: 'ui_7',
  method: 'confirm',
  title: '运行命令',
  message: 'npm run build'
}

describe('parseAccessMode', () => {
  it('defaults to asking, including for junk', () => {
    expect(parseAccessMode(null)).toBe('ask')
    expect(parseAccessMode(undefined)).toBe('ask')
    expect(parseAccessMode('')).toBe('ask')
    expect(parseAccessMode('yolo')).toBe('ask')
    expect(parseAccessMode('ask')).toBe('ask')
  })

  it('only the exact literal turns it on', () => {
    expect(parseAccessMode('full')).toBe('full')
    expect(parseAccessMode('Full')).toBe('ask')
  })
})

describe('shouldAutoApprove', () => {
  it('answers confirm dialogs under full access', () => {
    expect(shouldAutoApprove(confirmFrame, 'full')).toBe(true)
  })

  it('never answers anything in ask mode', () => {
    expect(shouldAutoApprove(confirmFrame, 'ask')).toBe(false)
  })

  it('leaves dialogs that ask for content to the user, even under full access', () => {
    for (const method of DIALOG_METHODS.filter((m) => m !== 'confirm')) {
      expect(shouldAutoApprove({ ...confirmFrame, method }, 'full')).toBe(false)
    }
  })

  it('ignores display-only extension methods and other frame types', () => {
    expect(shouldAutoApprove({ ...confirmFrame, method: 'setStatus' }, 'full')).toBe(false)
    expect(shouldAutoApprove({ type: 'notice', method: 'confirm', id: 'x' }, 'full')).toBe(false)
    expect(shouldAutoApprove({ type: 'tool_execution_start', id: 'x' }, 'full')).toBe(false)
  })

  it('refuses a frame with no id — there would be nothing to answer', () => {
    expect(shouldAutoApprove({ ...confirmFrame, id: '' }, 'full')).toBe(false)
    expect(shouldAutoApprove({ type: 'extension_ui_request', method: 'confirm' }, 'full')).toBe(false)
  })
})

describe('autoApprovalLabel', () => {
  it('names what was approved so the transcript is auditable', () => {
    expect(autoApprovalLabel(confirmFrame)).toBe('已自动允许:运行命令')
  })

  it('falls back to the message, collapsed to one line', () => {
    expect(autoApprovalLabel({ message: '删除\n  两个文件' })).toBe('已自动允许:删除 两个文件')
  })

  it('still says something when the frame carries no words', () => {
    expect(autoApprovalLabel({})).toBe('已自动允许一次工具确认')
  })
})
