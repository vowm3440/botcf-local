import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  applyToolEvent,
  emptyTurnFileState,
  extractToolFilePath,
  isMutatingToolName,
  listChangedFiles,
  toDisplayPath,
  type ToolEventLike,
  type TurnFileState
} from '../src/omp/fileChanges.js'

const WORKDIR = path.resolve('proj')

function runEvents(events: ToolEventLike[], workdir: string | null = WORKDIR): TurnFileState {
  return events.reduce((state, event) => applyToolEvent(state, event, workdir), emptyTurnFileState)
}

describe('isMutatingToolName', () => {
  it('accepts editing/writing tool name variants', () => {
    for (const name of ['edit', 'write', 'multi_edit', 'multiEdit', 'apply_patch', 'create_file', 'str_replace_editor', 'notebook_edit']) {
      expect(isMutatingToolName(name), name).toBe(true)
    }
  })

  it('rejects read-only and shell tools', () => {
    for (const name of ['read', 'grep', 'glob', 'ls', 'list_dir', 'find', 'bash', 'shell', 'exec', 'web_fetch', 'todo_write']) {
      expect(isMutatingToolName(name), name).toBe(false)
    }
  })

  it('rejects unknown tool names', () => {
    expect(isMutatingToolName('frobnicate')).toBe(false)
  })
})

describe('extractToolFilePath', () => {
  it('reads common field name variants', () => {
    expect(extractToolFilePath({ path: 'a.ts' })).toBe('a.ts')
    expect(extractToolFilePath({ file_path: 'b.ts' })).toBe('b.ts')
    expect(extractToolFilePath({ filePath: 'c.ts' })).toBe('c.ts')
    expect(extractToolFilePath({ filename: 'd.ts' })).toBe('d.ts')
    expect(extractToolFilePath({ file: 'e.ts' })).toBe('e.ts')
  })

  it('prefers the canonical path field and trims whitespace', () => {
    expect(extractToolFilePath({ path: '  a.ts  ', filename: 'other.ts' })).toBe('a.ts')
  })

  it('returns null for non-objects, arrays and non-string values', () => {
    expect(extractToolFilePath(undefined)).toBeNull()
    expect(extractToolFilePath('a.ts')).toBeNull()
    expect(extractToolFilePath(['a.ts'])).toBeNull()
    expect(extractToolFilePath({ path: 42 })).toBeNull()
    expect(extractToolFilePath({ path: '   ' })).toBeNull()
  })
})

describe('toDisplayPath', () => {
  it('turns paths inside the workdir into POSIX relative paths', () => {
    expect(toDisplayPath(path.join(WORKDIR, 'src', 'app.ts'), WORKDIR)).toBe('src/app.ts')
    expect(toDisplayPath(path.join('src', 'app.ts'), WORKDIR)).toBe('src/app.ts')
  })

  it('keeps paths outside the workdir absolute', () => {
    const outside = path.resolve('elsewhere', 'x.ts')
    expect(toDisplayPath(outside, WORKDIR)).toBe(outside.replace(/\\/g, '/'))
  })

  it('normalizes separators when no workdir is set', () => {
    expect(toDisplayPath('src\\deep\\a.ts', null)).toBe('src/deep/a.ts')
  })
})

describe('applyToolEvent', () => {
  it('records an edit with a diff on the end frame', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'edit', args: { path: 'src/app.ts' } },
      { phase: 'end', id: 't1', name: 'edit', diff: '-a\n+b' }
    ])
    expect(listChangedFiles(state)).toEqual([
      { path: 'src/app.ts', tools: ['edit'], lastToolCallId: 't1', hasDiff: true, isError: false }
    ])
  })

  it('records a write without a diff based on the tool name', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'write', args: { file_path: 'notes.md' } },
      { phase: 'end', id: 't1', name: 'write' }
    ])
    expect(listChangedFiles(state)).toEqual([
      { path: 'notes.md', tools: ['write'], lastToolCallId: 't1', hasDiff: false, isError: false }
    ])
  })

  it('counts unknown tools when the end frame carries a diff', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'mystery_tool', args: { path: 'x.ts' } },
      { phase: 'end', id: 't1', name: 'mystery_tool', diff: '+x' }
    ])
    expect(listChangedFiles(state)).toHaveLength(1)
  })

  it('picks up a diff that only appeared on an update frame', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'search_replace', args: { path: 'x.ts' } },
      { phase: 'update', id: 't1', name: 'search_replace', diff: '+x' },
      { phase: 'end', id: 't1', name: 'search_replace' }
    ])
    expect(listChangedFiles(state)).toEqual([
      { path: 'x.ts', tools: ['search_replace'], lastToolCallId: 't1', hasDiff: true, isError: false }
    ])
  })

  it('ignores read-only tools and shell commands', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'read', args: { path: 'src/app.ts' } },
      { phase: 'end', id: 't1', name: 'read' },
      { phase: 'start', id: 't2', name: 'bash', args: { command: 'rm -rf x' } },
      { phase: 'end', id: 't2', name: 'bash' }
    ])
    expect(listChangedFiles(state)).toEqual([])
  })

  it('skips failed calls without a diff but keeps failed calls with one', () => {
    const failedNoDiff = runEvents([
      { phase: 'start', id: 't1', name: 'edit', args: { path: 'a.ts' } },
      { phase: 'end', id: 't1', name: 'edit', isError: true }
    ])
    expect(listChangedFiles(failedNoDiff)).toEqual([])

    const failedWithDiff = runEvents([
      { phase: 'start', id: 't1', name: 'edit', args: { path: 'a.ts' } },
      { phase: 'end', id: 't1', name: 'edit', diff: '+partial', isError: true }
    ])
    expect(listChangedFiles(failedWithDiff)).toEqual([
      { path: 'a.ts', tools: ['edit'], lastToolCallId: 't1', hasDiff: true, isError: true }
    ])
  })

  it('skips mutating calls without any extractable path', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'apply_patch', args: { patch: '*** Begin Patch' } },
      { phase: 'end', id: 't1', name: 'apply_patch', diff: '+x' }
    ])
    expect(listChangedFiles(state)).toEqual([])
  })

  it('merges repeated edits to the same file across tools', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'write', args: { path: 'src/app.ts' } },
      { phase: 'end', id: 't1', name: 'write' },
      { phase: 'start', id: 't2', name: 'edit', args: { path: path.join(WORKDIR, 'src', 'app.ts') } },
      { phase: 'end', id: 't2', name: 'edit', diff: '+y' }
    ])
    expect(listChangedFiles(state)).toEqual([
      { path: 'src/app.ts', tools: ['write', 'edit'], lastToolCallId: 't2', hasDiff: true, isError: false }
    ])
  })

  it('ignores end frames without a matching start', () => {
    const state = runEvents([{ phase: 'end', id: 'ghost', name: 'edit', diff: '+x' }])
    expect(listChangedFiles(state)).toEqual([])
  })

  it('never mutates the previous state object', () => {
    const first = runEvents([{ phase: 'start', id: 't1', name: 'edit', args: { path: 'a.ts' } }])
    const before = first.pending.size
    applyToolEvent(first, { phase: 'end', id: 't1', name: 'edit', diff: '+x' }, WORKDIR)
    expect(first.pending.size).toBe(before)
    expect(first.changes.size).toBe(0)
  })
})
