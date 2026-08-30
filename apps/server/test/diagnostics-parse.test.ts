import { describe, expect, it } from 'vitest'
import { DiagnosticScanner, scanDiagnostics } from '../src/diagnostics/parse.js'

/** The scanner is fed one line at a time while a task streams, so the formats
 *  that print a location *after* their message (rust, node stacks) and the ones
 *  that print the file once above a block (eslint) are the interesting cases. */

describe('scanDiagnostics — tsc', () => {
  it('parses file(line,col): error TSxxxx', () => {
    const [found] = scanDiagnostics("src/api.ts(12,5): error TS2345: Argument of type 'string' is not assignable")
    expect(found).toMatchObject({
      file: 'src/api.ts',
      line: 12,
      column: 5,
      severity: 'error',
      code: 'TS2345',
      tool: 'tsc'
    })
  })

  it('parses a Windows absolute path and a warning', () => {
    const [found] = scanDiagnostics('D:\\do\\botcf\\src\\a.ts(3,1): warning TS6133: unused')
    expect(found).toMatchObject({ file: 'D:\\do\\botcf\\src\\a.ts', line: 3, severity: 'warning' })
  })
})

describe('scanDiagnostics — clang/esbuild/vite style', () => {
  it('parses file:line:col: error: message', () => {
    const [found] = scanDiagnostics('src/main.tsx:8:22: error: Expected ")" but found "}"')
    expect(found).toMatchObject({ file: 'src/main.tsx', line: 8, column: 22, severity: 'error', tool: 'clang' })
  })

  it('maps note to info', () => {
    const [found] = scanDiagnostics('src/a.c:4:2: note: expanded from here')
    expect(found?.severity).toBe('info')
  })

  it('ignores a bare clock-like string', () => {
    expect(scanDiagnostics('12:34:56 ready in 300 ms')).toEqual([])
  })
})

describe('scanDiagnostics — eslint stylish', () => {
  it('attributes indented findings to the file printed above them', () => {
    const found = scanDiagnostics(
      ['', '/repo/src/App.tsx', '  12:9  error    Unexpected console statement  no-console', '  40:1  warning  Missing return type  @typescript-eslint/explicit-function-return-type', ''].join('\n')
    )
    expect(found).toHaveLength(2)
    expect(found[0]).toMatchObject({ file: '/repo/src/App.tsx', line: 12, column: 9, severity: 'error', code: 'no-console', tool: 'eslint' })
    expect(found[1]).toMatchObject({ line: 40, severity: 'warning', code: '@typescript-eslint/explicit-function-return-type' })
  })

  it('stops attributing after the file block ends', () => {
    const found = scanDiagnostics(['/repo/a.ts', '  1:1  error  bad  rule', '', '  2:2  error  orphan  rule'].join('\n'))
    expect(found).toHaveLength(1)
  })
})

describe('scanDiagnostics — rust', () => {
  it('joins the message with the arrow location', () => {
    const [found] = scanDiagnostics(['error[E0382]: borrow of moved value: `x`', '  --> src/main.rs:10:5'].join('\n'))
    expect(found).toMatchObject({ file: 'src/main.rs', line: 10, column: 5, code: 'E0382', tool: 'rust' })
  })

  it('drops a message whose location never arrives', () => {
    expect(scanDiagnostics(['warning: unused variable', 'a', 'b', 'c', 'd', 'e', 'f', '  --> src/x.rs:1:1'].join('\n'))).toEqual([])
  })
})

describe('scanDiagnostics — tests and node errors', () => {
  it('reports a failing test file', () => {
    const [found] = scanDiagnostics(' FAIL  test/chat.test.ts > streams tool events')
    expect(found).toMatchObject({ file: 'test/chat.test.ts', line: 1, severity: 'error', tool: 'vitest' })
    expect(found?.message).toContain('streams tool events')
  })

  it('pairs a node error with the first stack frame', () => {
    const [found] = scanDiagnostics(
      ['TypeError: Cannot read properties of undefined', '    at load (/repo/src/api.ts:44:19)', '    at next (/repo/src/b.ts:1:1)'].join('\n')
    )
    expect(found).toMatchObject({ file: '/repo/src/api.ts', line: 44, column: 19, tool: 'node' })
    expect(found?.message).toContain('TypeError')
  })

  it('uses the vitest arrow frame as a location too', () => {
    const found = scanDiagnostics(['AssertionError: expected 1 to be 2', ' ❯ test/a.test.ts:7:14'].join('\n'))
    expect(found[0]).toMatchObject({ file: 'test/a.test.ts', line: 7 })
  })
})

describe('DiagnosticScanner', () => {
  it('keeps no state across reset', () => {
    const scanner = new DiagnosticScanner()
    scanner.push('/repo/a.ts')
    scanner.reset()
    expect(scanner.push('  1:1  error  message  rule')).toEqual([])
  })

  it('returns nothing for ordinary build chatter', () => {
    const scanner = new DiagnosticScanner()
    for (const line of ['> tsc -p .', 'vite v8.2.1 building for production...', '✓ 42 modules transformed', 'built in 3.21s']) {
      expect(scanner.push(line)).toEqual([])
    }
  })
})
