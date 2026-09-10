import { describe, expect, it } from 'vitest'
import { mergeLogLines } from '../src/components/logLines'

const lines = (...seqs: number[]) => seqs.map((seq) => ({ seq, text: `output ${seq}` }))

describe('log snapshot and live output reconciliation', () => {
  it('restores earlier history when a snapshot arrives after live output without repeating shared lines', () => {
    const live = lines(4, 5)
    expect(mergeLogLines(live, lines(1, 2, 3, 4), 10)).toEqual(lines(1, 2, 3, 4, 5))
  })

  it('fills a reconnect gap even after a newer frame has already arrived', () => {
    expect(mergeLogLines(lines(1, 2, 6), lines(3, 4, 5, 6), 10)).toEqual(lines(1, 2, 3, 4, 5, 6))
  })

  it('keeps the newest bounded window when an older snapshot is replayed', () => {
    expect(mergeLogLines(lines(5, 6, 7), lines(1, 2, 3, 4, 5, 6), 3)).toEqual(lines(5, 6, 7))
  })

  it('does not resurrect cleared output when a pending snapshot completes', () => {
    expect(mergeLogLines(lines(6), lines(1, 2, 3, 4, 5), 10, 4)).toEqual(lines(5, 6))
  })
})
