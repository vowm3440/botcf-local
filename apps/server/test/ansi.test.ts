import { describe, expect, it } from 'vitest'
import { applyCarriageReturns, cleanCapturedText, cleanOutputLine, stripAnsi } from '../src/process/ansi.js'

/** Tool results reach the transcript as raw process output. A PowerShell session
 *  shows what a terminal *left on screen*; a `<pre>` shows every byte, escape
 *  sequences and overwritten progress bars included. This module is the
 *  difference, so the chat pane's tool output reads like the shell's. */

const ESC = '\x1b'

describe('stripAnsi', () => {
  it('removes colour, cursor and erase sequences', () => {
    expect(stripAnsi(`${ESC}[32mok${ESC}[39m${ESC}[2K`)).toBe('ok')
  })

  it('removes OSC window titles and short escapes', () => {
    expect(stripAnsi(`${ESC}]0;D:\\do\\botcf${ESC}\\PS>`)).toBe('PS>')
    expect(stripAnsi(`${ESC}(Bplain`)).toBe('plain')
  })
})

describe('applyCarriageReturns', () => {
  it('keeps only what survived the last overwrite', () => {
    expect(applyCarriageReturns('10%\r55%\r100%')).toBe('100%')
  })

  it('leaves a line without carriage returns alone', () => {
    expect(applyCarriageReturns('done')).toBe('done')
  })
})

describe('cleanOutputLine', () => {
  it('strips escapes, applies overwrites and trims trailing space', () => {
    expect(cleanOutputLine(`${ESC}[36m  building 1%\r  built  ${ESC}[0m   `)).toBe('  built')
  })
})

describe('cleanCapturedText', () => {
  it('cleans every line of a multi-line tool result', () => {
    const raw = `${ESC}[1msrc/a.ts${ESC}[0m\r\n  1:1  ${ESC}[31merror${ESC}[0m  bad   \r\n0%\r100% done`
    expect(cleanCapturedText(raw)).toBe('src/a.ts\n  1:1  error  bad\n100% done')
  })

  it('normalises CRLF without eating blank lines', () => {
    expect(cleanCapturedText('a\r\n\r\nb')).toBe('a\n\nb')
  })

  it('leaves clean text untouched', () => {
    expect(cleanCapturedText('plain\ntext')).toBe('plain\ntext')
  })

  it('handles an empty result', () => {
    expect(cleanCapturedText('')).toBe('')
  })
})
