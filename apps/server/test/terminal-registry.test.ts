import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcriptFile } from '../src/logs/transcripts.js'
import { TerminalRegistry } from '../src/terminal/registry.js'
import { TerminalSession, type TerminalLine, type TerminalSessionOptions } from '../src/terminal/session.js'

/** Registry-level transcript lifecycle: a session's full output lands in
 *  <dataDir>/logs/terminals/ while the session record lives, and the file is
 *  removed when the record is closed, pruned or its root leaves the workspace. */

class FakeShell extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
  kill = vi.fn(() => true)
  /** No real process: killTree returns immediately instead of waiting. */
  pid: number | undefined = undefined
}

const temps: string[] = []
const registries: TerminalRegistry[] = []

afterEach(async () => {
  for (const registry of registries) await registry.closeAll().catch(() => undefined)
  registries.length = 0
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
  temps.length = 0
})

function makeRegistry(): { registry: TerminalRegistry; shells: FakeShell[]; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-term-reg-'))
  temps.push(dir)
  const shells: FakeShell[] = []
  const registry = new TerminalRegistry(dir, (options: TerminalSessionOptions) => {
    const shell = new FakeShell()
    shells.push(shell)
    return new TerminalSession({
      ...options,
      spawnProcess: (() => shell) as unknown as typeof import('node:child_process').spawn
    })
  })
  registries.push(registry)
  return { registry, shells, dir }
}

function startSession(registry: TerminalRegistry, rootId: string) {
  const created = registry.create({ rootId, rootName: 'app', cwd: '/tmp/app' })
  if (!created.ok) throw new Error('create should be accepted')
  return created.session
}

describe('TerminalRegistry transcripts', () => {
  it('persists a full session and removes the file when the session closes', async () => {
    const { registry, shells, dir } = makeRegistry()
    const session = startSession(registry, 'r1')
    const file = transcriptFile(dir, 'terminals', 'r1', session.id)
    shells[0].stdout.write('hello world\n')
    await vi.waitFor(() =>
      expect(session.snapshot().some((line: TerminalLine) => line.kind === 'stdout' && line.text === 'hello world')).toBe(true)
    )
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('hello world')

    const closed = await registry.close(session.id)
    expect(closed).toBe(true)
    expect(registry.get(session.id)).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('removes transcripts of a root that leaves the workspace and keeps the rest', async () => {
    const { registry, shells, dir } = makeRegistry()
    const sessionA = startSession(registry, 'ra')
    const sessionB = startSession(registry, 'rb')
    shells[0].stdout.write('a\n')
    shells[1].stdout.write('b\n')
    await vi.waitFor(() => expect(sessionA.snapshot().some((l: TerminalLine) => l.text === 'a')).toBe(true))
    await vi.waitFor(() => expect(sessionB.snapshot().some((l: TerminalLine) => l.text === 'b')).toBe(true))

    const closed = await registry.closeForRoot('ra')
    expect(closed).toBe(1)
    expect(fs.existsSync(transcriptFile(dir, 'terminals', 'ra', sessionA.id))).toBe(false)
    expect(fs.existsSync(transcriptFile(dir, 'terminals', 'rb', sessionB.id))).toBe(true)
  })

  it('drops the oldest transcript once exited sessions pile up', async () => {
    const { registry, shells, dir } = makeRegistry()
    const files: string[] = []
    const ids: string[] = []
    // Six sessions, each exited right after it starts. Every create prunes the
    // exited list down to MAX_EXITED_SESSIONS, so the first session is dropped
    // when the sixth is created — its transcript file must go with it.
    for (let i = 0; i < 6; i++) {
      const session = startSession(registry, 'r1')
      ids.push(session.id)
      files.push(transcriptFile(dir, 'terminals', 'r1', session.id))
      shells[i].stdout.write(`run ${i}\n`)
      await vi.waitFor(() => expect(session.snapshot().some((l: TerminalLine) => l.kind === 'stdout')).toBe(true))
      shells[i].emit('close', 0, null)
      await vi.waitFor(() => expect(session.running).toBe(false))
    }
    // A brand-new session counts as not-yet-running during its own create's
    // prune, so the sixth create prunes down to four by dropping the first two
    // exited sessions — their transcript files must go with them.
    expect(fs.existsSync(files[0])).toBe(false)
    expect(fs.existsSync(files[1])).toBe(false)
    expect(fs.existsSync(files[2])).toBe(true)
    expect(registry.get(ids[0])).toBeNull()
    expect(registry.get(ids[1])).toBeNull()
    expect(registry.get(ids[2])).not.toBeNull()
    expect(registry.list()).toHaveLength(4)
  })

  it('removes every transcript on closeAll', async () => {
    const { registry, shells, dir } = makeRegistry()
    const files: string[] = []
    for (let i = 0; i < 2; i++) {
      const session = startSession(registry, 'r1')
      files.push(transcriptFile(dir, 'terminals', 'r1', session.id))
      shells[i].stdout.write(`x ${i}\n`)
      await vi.waitFor(() => expect(session.snapshot().some((l: TerminalLine) => l.kind === 'stdout')).toBe(true))
    }
    await registry.closeAll()
    expect(registry.list()).toHaveLength(0)
    expect(files.some((file) => fs.existsSync(file))).toBe(false)
  })
})
