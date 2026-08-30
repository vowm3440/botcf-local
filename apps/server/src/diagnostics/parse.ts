/** Compiler/linter/test output → structured diagnostics.
 *
 *  Everything here is pure text work, and deliberately incremental: the scanner
 *  is fed one line at a time as a task streams, because the diagnostics center
 *  must fill up *while* a build runs, not after it finishes. A few formats need
 *  context across lines (eslint prints the file once above its findings, rust and
 *  node print the location *after* the message), so the scanner keeps that little
 *  state itself.
 *
 *  Recognized shapes:
 *    tsc      src/a.ts(12,5): error TS2345: message
 *    clang    src/a.ts:12:5: error: message      (esbuild, vite, gcc, swc …)
 *    eslint   src/a.ts ⏎ "  12:5  error  message  rule"
 *    rust     error[E0382]: message ⏎ "  --> src/a.rs:12:5"
 *    vitest   FAIL src/a.test.ts > case ⏎ "❯ src/a.ts:12:5"
 *    node     TypeError: message ⏎ "    at fn (/abs/a.ts:12:5)" */

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export type DiagnosticTool = 'tsc' | 'eslint' | 'clang' | 'rust' | 'vitest' | 'node'

export interface RawDiagnostic {
  /** Path exactly as the tool printed it: relative to the run cwd, or absolute. */
  file: string
  line: number
  column: number | null
  severity: DiagnosticSeverity
  code: string | null
  message: string
  tool: DiagnosticTool
}

/** A path fragment, optionally starting with a Windows drive letter. */
const FILE = String.raw`((?:[A-Za-z]:)?[^\s:][^:]*?)`

const TSC = new RegExp(`^\\s*${FILE}\\((\\d+),(\\d+)\\)\\s*:\\s*(error|warning|info)\\s+([A-Za-z]+\\d+)\\s*:\\s*(.+)$`)
const CLANG = new RegExp(`^\\s*${FILE}:(\\d+):(\\d+)\\s*:\\s*(error|warning|note|info)\\s*:\\s*(.+)$`, 'i')
const ESLINT_FILE = /^(?:[A-Za-z]:)?[^\s].*\.(?:[cm]?[jt]sx?|vue|svelte|astro|json|ya?ml|css|scss|md)$/
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s{2,}(.+?)(?:\s{2,}([\w@/.-]+))?\s*$/
const RUST_HEAD = /^(error|warning)(?:\[([A-Za-z0-9]+)\])?:\s*(.+)$/
const RUST_LOCATION = new RegExp(`^\\s*-->\\s*${FILE}:(\\d+):(\\d+)\\s*$`)
const VITEST_FAIL = /^\s*(?:FAIL|✗|×|FAILED)\s+(\S+\.[A-Za-z]+)(?:\s*[>›]\s*(.+))?$/
const STACK_LOCATION = new RegExp(`^\\s*(?:at|❯|-->)\\s+(?:.*?\\()?${FILE}:(\\d+):(\\d+)\\)?\\s*$`)
const NODE_ERROR = /^\s*(?:Uncaught\s+)?([A-Z][A-Za-z]*(?:Error|Exception)):\s*(.+)$/

/** A location match must actually look like a path, not like a clock or a range. */
function looksLikePath(file: string): boolean {
  return /[./\\]/.test(file) && !/^\d+$/.test(file)
}

function severityOf(word: string): DiagnosticSeverity {
  const lowered = word.toLowerCase()
  if (lowered.startsWith('warn')) return 'warning'
  if (lowered === 'note' || lowered === 'info' || lowered === 'hint') return 'info'
  return 'error'
}

const MAX_MESSAGE_CHARS = 500

const clip = (message: string): string => message.trim().slice(0, MAX_MESSAGE_CHARS)

interface PendingMessage {
  severity: DiagnosticSeverity
  code: string | null
  message: string
  tool: DiagnosticTool
  /** Lines since the message was seen; its location must follow closely. */
  age: number
}

/** How many lines a "message first, location later" pair may be apart. */
const PENDING_WINDOW = 6

/** Stateful line scanner. One instance per task run / log stream. */
export class DiagnosticScanner {
  private eslintFile: string | null = null
  private pending: PendingMessage | null = null

  /** Feed one output line; returns the diagnostics it completed (usually none). */
  push(rawLine: string): RawDiagnostic[] {
    const line = rawLine.replace(/\s+$/, '')
    if (line === '') {
      // A blank line closes an eslint file block but not a pending message.
      this.eslintFile = null
      return []
    }
    if (this.pending) {
      this.pending.age++
      if (this.pending.age > PENDING_WINDOW) this.pending = null
    }

    const tsc = TSC.exec(line)
    if (tsc && looksLikePath(tsc[1])) {
      return [
        {
          file: tsc[1],
          line: Number(tsc[2]),
          column: Number(tsc[3]),
          severity: severityOf(tsc[4]),
          code: tsc[5],
          message: clip(tsc[6]),
          tool: 'tsc'
        }
      ]
    }

    const eslintRow = this.eslintFile ? ESLINT_ROW.exec(line) : null
    if (eslintRow && this.eslintFile) {
      return [
        {
          file: this.eslintFile,
          line: Number(eslintRow[1]),
          column: Number(eslintRow[2]),
          severity: severityOf(eslintRow[3]),
          code: eslintRow[5] ?? null,
          message: clip(eslintRow[4]),
          tool: 'eslint'
        }
      ]
    }

    const clang = CLANG.exec(line)
    if (clang && looksLikePath(clang[1])) {
      return [
        {
          file: clang[1],
          line: Number(clang[2]),
          column: Number(clang[3]),
          severity: severityOf(clang[4]),
          code: null,
          message: clip(clang[5]),
          tool: 'clang'
        }
      ]
    }

    const rustLocation = RUST_LOCATION.exec(line)
    if (rustLocation && this.pending && looksLikePath(rustLocation[1])) {
      const pending = this.pending
      this.pending = null
      return [
        {
          file: rustLocation[1],
          line: Number(rustLocation[2]),
          column: Number(rustLocation[3]),
          severity: pending.severity,
          code: pending.code,
          message: pending.message,
          tool: pending.tool
        }
      ]
    }

    const stack = STACK_LOCATION.exec(line)
    if (stack && this.pending && looksLikePath(stack[1])) {
      const pending = this.pending
      this.pending = null
      return [
        {
          file: stack[1],
          line: Number(stack[2]),
          column: Number(stack[3]),
          severity: pending.severity,
          code: pending.code,
          message: pending.message,
          tool: pending.tool
        }
      ]
    }

    const rustHead = RUST_HEAD.exec(line)
    if (rustHead) {
      this.pending = {
        severity: severityOf(rustHead[1]),
        code: rustHead[2] ?? null,
        message: clip(rustHead[3]),
        tool: 'rust',
        age: 0
      }
      return []
    }

    const nodeError = NODE_ERROR.exec(line)
    if (nodeError) {
      this.pending = {
        severity: 'error',
        code: nodeError[1],
        message: clip(`${nodeError[1]}: ${nodeError[2]}`),
        tool: 'node',
        age: 0
      }
      return []
    }

    const fail = VITEST_FAIL.exec(line)
    if (fail && looksLikePath(fail[1])) {
      return [
        {
          file: fail[1],
          line: 1,
          column: null,
          severity: 'error',
          code: null,
          message: clip(fail[2] ? `测试失败: ${fail[2]}` : '测试失败'),
          tool: 'vitest'
        }
      ]
    }

    if (ESLINT_FILE.test(line)) {
      this.eslintFile = line.trim()
      return []
    }
    return []
  }

  reset(): void {
    this.eslintFile = null
    this.pending = null
  }
}

/** Convenience for whole buffers (tests, and re-scanning a finished run). */
export function scanDiagnostics(text: string): RawDiagnostic[] {
  const scanner = new DiagnosticScanner()
  return text.split(/\r?\n/).flatMap((line) => scanner.push(line))
}
