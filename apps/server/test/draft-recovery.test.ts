import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_DRAFT_RECOVERY_BYTES,
  clearRootDraftRecovery,
  deleteDraftRecovery,
  draftEntryFile,
  readDraftRecovery,
  rootDraftDir,
  writeDraftRecovery
} from '../src/drafts/recovery.js'

const temps: string[] = []
function makeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-drafts-'))
  temps.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

describe('draft recovery log', () => {
  it('round-trips an entry under <dataDir>/drafts/<rootId>/<relative>', () => {
    const data = makeDataDir()
    writeDraftRecovery(data, 'ra1b2c3d4e', 'src/App.tsx', 'edited body', 1_725_000_000_000)
    const file = draftEntryFile(data, 'ra1b2c3d4e', 'src/App.tsx')
    expect(file).toBe(path.join(rootDraftDir(data, 'ra1b2c3d4e'), 'src', 'App.tsx'))
    expect(fs.existsSync(file!)).toBe(true)
    const entry = readDraftRecovery(data, 'ra1b2c3d4e', 'src/App.tsx')
    expect(entry).toMatchObject({ content: 'edited body', baseMtimeMs: 1_725_000_000_000 })
    expect(entry!.savedAt).toBeGreaterThan(0)
  })

  it('keeps roots separate and cleans the whole root on removal', () => {
    const data = makeDataDir()
    writeDraftRecovery(data, 'rootA', 'a.txt', 'A', 1)
    writeDraftRecovery(data, 'rootB', 'nested/b.txt', 'B', 2)
    expect(readDraftRecovery(data, 'rootA', 'a.txt')?.content).toBe('A')
    expect(readDraftRecovery(data, 'rootB', 'nested/b.txt')?.content).toBe('B')

    const removed = clearRootDraftRecovery(data, 'rootA')
    expect(removed).toBe(1)
    expect(readDraftRecovery(data, 'rootA', 'a.txt')).toBeNull()
    expect(readDraftRecovery(data, 'rootB', 'nested/b.txt')?.content).toBe('B')
    expect(fs.existsSync(rootDraftDir(data, 'rootA'))).toBe(false)
  })

  it('overwrites, deletes, and reports a missing entry as null', () => {
    const data = makeDataDir()
    expect(readDraftRecovery(data, 'root', 'none.txt')).toBeNull()
    expect(deleteDraftRecovery(data, 'root', 'none.txt')).toBe(false)

    writeDraftRecovery(data, 'root', 'f.txt', 'v1', 10)
    writeDraftRecovery(data, 'root', 'f.txt', 'v2', 20)
    expect(readDraftRecovery(data, 'root', 'f.txt')).toMatchObject({ content: 'v2', baseMtimeMs: 20 })

    expect(deleteDraftRecovery(data, 'root', 'f.txt')).toBe(true)
    expect(readDraftRecovery(data, 'root', 'f.txt')).toBeNull()
  })

  it('refuses paths that could leave the root draft directory', () => {
    const data = makeDataDir()
    expect(draftEntryFile(data, 'root', '../escape.txt')).toBeNull()
    expect(draftEntryFile(data, 'root', 'a/../../escape.txt')).toBeNull()
    expect(draftEntryFile(data, 'root', '/abs/path')).toBeNull()
    expect(draftEntryFile(data, 'root', '')).toBeNull()
    expect(() => writeDraftRecovery(data, 'root', '../escape.txt', 'x', 1)).toThrow()
  })

  it('refuses drafts over the editor content cap', () => {
    const data = makeDataDir()
    const oversized = 'x'.repeat(MAX_DRAFT_RECOVERY_BYTES + 1)
    expect(() => writeDraftRecovery(data, 'root', 'big.txt', oversized, 1)).toThrow(/上限/)
  })

  it('reads a corrupt entry as null instead of throwing', () => {
    const data = makeDataDir()
    const file = draftEntryFile(data, 'root', 'broken.json')!
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json', 'utf8')
    expect(readDraftRecovery(data, 'root', 'broken.json')).toBeNull()
  })
})
