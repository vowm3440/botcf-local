import { describe, expect, it, vi } from 'vitest'
import { draftAction, isDirty } from '../src/editor/draftPolicy'

describe('isDirty', () => {
  it('is dirty as soon as the length differs, without reading the text', () => {
    const read = vi.fn(() => 'unused')
    expect(isDirty({ length: 5, lines: 1 }, 'abcd', read)).toBe(true)
    // The point of the length check: typing must not serialise the buffer.
    expect(read).not.toHaveBeenCalled()
  })

  it('is clean when an undo brings the buffer back to the snapshot', () => {
    expect(isDirty({ length: 4, lines: 1 }, 'abcd', () => 'abcd')).toBe(false)
  })

  it('is dirty when the length matches but the content does not', () => {
    expect(isDirty({ length: 4, lines: 1 }, 'abcd', () => 'abce')).toBe(true)
  })

  it('reads the text only when the lengths agree', () => {
    const read = vi.fn(() => 'abcd')
    isDirty({ length: 4, lines: 1 }, 'abcd', read)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('treats an empty buffer against an empty snapshot as clean', () => {
    expect(isDirty({ length: 0, lines: 1 }, '', () => '')).toBe(false)
  })

  it('is clean when there is no live buffer at all — that is not an empty one', () => {
    // The 内联 and 差异 views unmount the editor, and a file the assistant changed opens
    // in 内联. Reading `''` there marked every such file unsaved and cached an empty
    // draft for it, which the next open would have shown as an empty file.
    expect(isDirty({ length: 4, lines: 1 }, 'abcd', () => null)).toBe(false)
  })

  it('still reports a length mismatch without reading anything, even with no buffer', () => {
    const read = vi.fn(() => null)
    expect(isDirty({ length: 9, lines: 1 }, 'abcd', read)).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('draftAction', () => {
  it('writes once when the buffer first diverges from disk', () => {
    expect(draftAction(true, false)).toEqual({ kind: 'write' })
  })

  it('does not rewrite on later keystrokes — that is the whole saving', () => {
    expect(draftAction(true, true)).toEqual({ kind: 'none' })
  })

  it('clears a cached draft once the buffer matches disk again', () => {
    expect(draftAction(false, true)).toEqual({ kind: 'clear' })
  })

  it('does nothing when there is nothing cached and nothing to cache', () => {
    expect(draftAction(false, false)).toEqual({ kind: 'none' })
  })
})
