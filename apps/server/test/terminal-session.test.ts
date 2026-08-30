import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { TerminalSession, type TerminalLine } from '../src/terminal/session.js'
import { defaultShell, isShellKind, kindFromShellPath, resolveShell, shellByKind } from '../src/terminal/shell.js'

/** The terminal drives a real shell over pipes. The contract worth pinning down:
 *  input is echoed into the transcript (so several panels show the same history),
 *  output is cleaned and redacted, a prompt without a newline still appears, and a
 *  dead session refuses input with a clear message instead of silently dropping it. */

class FakeShell extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
  pid = 777
  kill = vi.fn(() => true)
  written = ''

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.toString()
    })
  }
}

function makeSession(child: FakeShell) {
  return new TerminalSession({
    id: 't1',
    rootId: 'r1',
    rootName: 'app',
    cwd: '/tmp/app',
    shell: shellByKind('bash'),
    spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn
  })
}

describe('shell selection', () => {
  it('defaults to PowerShell on Windows', () => {
    expect(defaultShell('win32', {}).kind).toBe('powershell')
  })

  it('follows the login shell on POSIX when it is one we can drive', () => {
    expect(defaultShell('linux', { SHELL: '/bin/zsh' }).kind).toBe('zsh')
    expect(defaultShell('darwin', { SHELL: '/usr/local/bin/fish' }).kind).toBe('sh')
    expect(defaultShell('linux', {}).kind).toBe('sh')
  })

  it('starts every shell in a read-from-stdin mode', () => {
    expect(shellByKind('bash').args).toContain('-s')
    expect(shellByKind('powershell').args).toEqual(expect.arrayContaining(['-NoProfile', '-Command', '-']))
    expect(shellByKind('cmd').args).toContain('/K')
  })

  it('falls back when the preference cannot apply on this platform', () => {
    expect(resolveShell('bash', 'win32', {}).kind).toBe('powershell')
    expect(resolveShell('powershell', 'linux', {}).kind).toBe('sh')
    expect(resolveShell('bash', 'linux', {}).kind).toBe('bash')
    expect(resolveShell(null, 'linux', { SHELL: '/bin/bash' }).kind).toBe('bash')
  })

  it('recognizes known shells and rejects anything else', () => {
    expect(kindFromShellPath('/usr/bin/bash')).toBe('bash')
    expect(kindFromShellPath('C:\\Windows\\System32\\cmd.exe')).toBe('cmd')
    expect(kindFromShellPath('/opt/weird/shell')).toBeNull()
    expect(isShellKind('zsh')).toBe(true)
    expect(isShellKind('/bin/sh')).toBe(false)
  })
})

describe('TerminalSession', () => {
  it('echoes input into the transcript and writes it to the shell', async () => {
    const child = new FakeShell()
    const session = makeSession(child)
    session.start()
    expect(session.write('git status')).toEqual({ ok: true })
    await vi.waitFor(() => expect(child.written).toBe('git status\n'))
    expect(session.snapshot().some((line) => line.kind === 'input' && line.text === 'git status')).toBe(true)
  })

  it('records the shell and directory as the first line', () => {
    const child = new FakeShell()
    const session = makeSession(child)
    session.start()
    const [first] = session.snapshot()
    expect(first).toMatchObject({ kind: 'system' })
    expect(first.text).toContain('/tmp/app')
  })

  it('splits output into lines and marks the stream', async () => {
    const child = new FakeShell()
    const session = makeSession(child)
    const lines: TerminalLine[] = []
    session.on('line', (line: TerminalLine) => lines.push(line))
    session.start()
    child.stdout.write('one\ntwo\n')
    child.stderr.write('fatal: not a repository\n')
    await vi.waitFor(() => expect(lines.filter((line) => line.kind !== 'system').length).toBe(3))
    expect(lines.filter((line) => line.kind === 'stdout').map((line) => line.text)).toEqual(['one', 'two'])
    expect(lines.find((line) => line.kind === 'stderr')?.text).toContain('not a repository')
  })

  it('flushes a prompt that never sends a newline', async () => {
    const child = new FakeShell()
    const session = makeSession(child)
    session.start()
    child.stdout.write('Are you sure? [y/N] ')
    await vi.waitFor(
      () => expect(session.snapshot().some((line) => line.text.includes('Are you sure?'))).toBe(true),
      { timeout: 2_000 }
    )
  })

  it('redacts secrets in output', async () => {
    const child = new FakeShell()
    const session = makeSession(child)
    session.start()
    child.stdout.write('export KEY=sk-abcdefghijklmn\n')
    await vi.waitFor(() => expect(session.snapshot().some((line) => line.text.includes('sk-'))).toBe(true))
    expect(session.snapshot().some((line) => line.text.includes('sk-abcdefghijklmn'))).toBe(false)
  })

  it('refuses input once the session ended, and says why', async () => {
    const child = new FakeShell()
    const session = makeSession(child)
    session.start()
    child.emit('exit', 0, null)
    await vi.waitFor(() => expect(session.running).toBe(false))
    const result = session.write('ls')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain('新建')
    expect(session.info()).toMatchObject({ running: false, exitCode: 0 })
  })

  it('refuses input containing NUL', () => {
    const child = new FakeShell()
    const session = makeSession(child)
    session.start()
    expect(session.write('ls\0-la')).toMatchObject({ ok: false })
  })

  it('replays only unseen lines', async () => {
    const child = new FakeShell()
    const session = makeSession(child)
    session.start()
    child.stdout.write('a\nb\n')
    await vi.waitFor(() => expect(session.snapshot().length).toBeGreaterThanOrEqual(3))
    const all = session.snapshot()
    expect(session.linesAfter(all[0].seq)).toHaveLength(all.length - 1)
    expect(session.linesAfter(all[all.length - 1].seq)).toEqual([])
  })

  it('reports a spawn failure instead of throwing', () => {
    const session = new TerminalSession({
      id: 't2',
      rootId: 'r1',
      rootName: 'app',
      cwd: '/tmp/app',
      shell: shellByKind('bash'),
      spawnProcess: (() => {
        throw new Error('ENOENT bash')
      }) as unknown as typeof import('node:child_process').spawn
    })
    session.start()
    expect(session.running).toBe(false)
    expect(session.snapshot().some((line) => line.text.includes('ENOENT bash'))).toBe(true)
  })
})
