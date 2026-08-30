/** ANSI/VT escape removal for captured child-process output.
 *
 *  Dev servers, task runners and shells colourise and rewrite their output. The
 *  panels render plain text, so every captured line passes through here first.
 *  The first character of each pattern is a literal ESC (0x1b) — intentional. */

/** CSI sequences: colours, cursor moves, erase-line … */
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
/** OSC sequences (window titles, hyperlinks), terminated by BEL or ST. */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
/** Two-character escapes and charset selections (ESC(B, ESC=, ESC>, …). */
const SHORT_ESCAPE = /\x1b[()#][0-9A-Za-z]|\x1b[=>78Mc]/g

export function stripAnsi(line: string): string {
  return line.replace(OSC, '').replace(CSI, '').replace(SHORT_ESCAPE, '')
}

/** Apply the carriage returns a progress bar leaves behind: everything before
 *  the last CR on a line has been overwritten in a real terminal, so only the
 *  final segment is what the user would see. */
export function applyCarriageReturns(line: string): string {
  const segments = line.split('\r')
  return segments[segments.length - 1] ?? line
}

/** Full cleanup for one captured output line. */
export function cleanOutputLine(line: string): string {
  return applyCarriageReturns(stripAnsi(line)).replace(/\s+$/, '')
}

/** The same cleanup for a multi-line block — a tool result, a captured stdout
 *  buffer. Line endings are normalised so the panels do not render a stray \r,
 *  and each line is reduced to what a terminal would have left on screen. */
export function cleanCapturedText(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map(cleanOutputLine).join('\n')
}
