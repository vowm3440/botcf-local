import { describe, expect, it } from 'vitest'
import { countLines } from '../src/editor/lineCount'

/** The contract that matters: identical to `split('\n').length`, because that is
 *  what the gutter used to be built from and both numbers are drawn together. */
function reference(value: string): number {
  return value.split('\n').length
}

describe('countLines', () => {
  const cases = [
    '',
    'a',
    'a\n',
    '\n',
    '\n\n',
    'a\nb',
    'a\nb\n',
    '\na',
    'line one\nline two\nline three',
    'trailing\n\n\n'
  ]

  for (const value of cases) {
    it(`agrees with split('\\n') for ${JSON.stringify(value)}`, () => {
      expect(countLines(value)).toBe(reference(value))
    })
  }

  it('counts a large buffer the way the editor loads one', () => {
    const value = Array.from({ length: 12_001 }, (_, index) => `line ${index}`).join('\n')
    expect(countLines(value)).toBe(12_001)
    expect(countLines(value)).toBe(reference(value))
  })

  it('does not treat a lone carriage return as a line break', () => {
    // CRLF files still count by '\n'; the '\r' stays part of the line, exactly as
    // the textarea and the line-number column render it.
    expect(countLines('a\r\nb')).toBe(2)
    expect(countLines('a\rb')).toBe(1)
  })
})
