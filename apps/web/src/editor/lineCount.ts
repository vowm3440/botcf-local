/** Line counting for buffers the editor holds whole.
 *
 *  Its own module because the number is needed in two places that must agree —
 *  the gutter's line-number column and the file's meta line — and because the
 *  obvious implementation is a performance bug on the files this editor is
 *  supposed to survive.
 *
 *  The obvious one is `for (i…) if (value[i] === '\n')`: on a 948 KB buffer that
 *  is ~950k index reads and ~950k single-character string comparisons, and it
 *  ran on every render — so every keystroke in a 12k-line file paid for it. The
 *  measurement that caught it is perf/editor-load.cjs; the keystroke block time
 *  was 143 ms p50 with the loop in place.
 *
 *  `indexOf` is the same scan handed to the engine's vectorised substring search
 *  instead of to the interpreter. Same answer, and the caller should still memo
 *  it on the buffer — this is O(n), just a much smaller constant. */

/** Number of lines in `value`, counting the last line whether or not the buffer
 *  ends with a newline (a trailing '\n' yields one final empty line, which is
 *  what `split('\n').length` reports and what the gutter has to draw). */
export function countLines(value: string): number {
  let lines = 1
  let index = value.indexOf('\n')
  while (index !== -1) {
    lines++
    index = value.indexOf('\n', index + 1)
  }
  return lines
}
