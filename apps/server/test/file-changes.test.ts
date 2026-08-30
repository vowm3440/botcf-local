import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  MAX_FILE_DIFF_CHARS,
  applyToolEvent,
  emptyTurnFileState,
  extractToolFilePath,
  isMutatingToolName,
  listChangedFiles,
  posixDisplayPath,
  type DisplayPathResolver,
  type ToolEventLike,
  type TurnFileState
} from '../src/omp/fileChanges.js'
import { EMPTY_WORKSPACE, addRoot, workspaceDisplayPath } from '../src/workspace/model.js'

const WORKDIR = path.resolve('proj')

const added = addRoot(EMPTY_WORKSPACE, { path: WORKDIR })
if (!added.ok) throw new Error(added.error)
const WORKSPACE = added.workspace

/** Qualified workspace path — the form changed files are recorded under. */
const q = (relative: string): string => `${added.root.name}/${relative}`

/** The resolver routes/chat.ts binds to the live workspace. */
const resolve: DisplayPathResolver = (raw) => workspaceDisplayPath(WORKSPACE, raw)

function runEvents(events: ToolEventLike[], resolveDisplayPath: DisplayPathResolver = resolve): TurnFileState {
  return events.reduce((state, event) => applyToolEvent(state, event, resolveDisplayPath), emptyTurnFileState)
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

describe('display path resolution', () => {
  it('records the qualified workspace path the resolver produced', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'edit', args: { path: path.join(WORKDIR, 'src', 'app.ts') } },
      { phase: 'end', id: 't1', name: 'edit', diff: '+x' }
    ])
    expect(listChangedFiles(state)[0]?.path).toBe('proj/src/app.ts')
  })

  it('keeps a file outside every root absolute, so the UI can refuse to open it', () => {
    const outside = path.resolve('elsewhere', 'x.ts')
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'edit', args: { path: outside } },
      { phase: 'end', id: 't1', name: 'edit', diff: '+x' }
    ])
    expect(listChangedFiles(state)[0]?.path).toBe(outside.replace(/\\/g, '/'))
  })

  it('falls back to separator normalization when no resolver is supplied', () => {
    expect(posixDisplayPath('src\\deep\\a.ts')).toBe('src/deep/a.ts')
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'edit', args: { path: 'src\\deep\\a.ts' } },
      { phase: 'end', id: 't1', name: 'edit', diff: '+x' }
    ], posixDisplayPath)
    expect(listChangedFiles(state)[0]?.path).toBe('src/deep/a.ts')
  })
})

describe('applyToolEvent', () => {
  it('records an edit with a diff on the end frame', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'edit', args: { path: 'src/app.ts' } },
      { phase: 'end', id: 't1', name: 'edit', diff: '-a\n+b' }
    ])
    expect(listChangedFiles(state)).toEqual([
      { path: q('src/app.ts'), tools: ['edit'], lastToolCallId: 't1', hasDiff: true, isError: false, diff: '-a\n+b' }
    ])
  })

  it('records a write without a diff based on the tool name', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'write', args: { file_path: 'notes.md' } },
      { phase: 'end', id: 't1', name: 'write' }
    ])
    expect(listChangedFiles(state)).toEqual([
      { path: q('notes.md'), tools: ['write'], lastToolCallId: 't1', hasDiff: false, isError: false }
    ])
  })

  it('counts unknown tools when the end frame carries a diff', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'mystery_tool', args: { path: 'x.ts' } },
      { phase: 'end', id: 't1', name: 'mystery_tool', diff: '+x' }
    ])
    expect(listChangedFiles(state)).toHaveLength(1)
  })

  it('picks up the latest diff streamed on update frames', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'search_replace', args: { path: 'x.ts' } },
      { phase: 'update', id: 't1', name: 'search_replace', diff: '+x' },
      { phase: 'update', id: 't1', name: 'search_replace', diff: '+x\n+y' },
      { phase: 'end', id: 't1', name: 'search_replace' }
    ])
    expect(listChangedFiles(state)).toEqual([
      { path: q('x.ts'), tools: ['search_replace'], lastToolCallId: 't1', hasDiff: true, isError: false, diff: '+x\n+y' }
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
      { path: q('a.ts'), tools: ['edit'], lastToolCallId: 't1', hasDiff: true, isError: true, diff: '+partial' }
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
      { path: q('src/app.ts'), tools: ['write', 'edit'], lastToolCallId: 't2', hasDiff: true, isError: false, diff: '+y' }
    ])
  })

  it('accumulates diffs from repeated calls on the same file', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'edit', args: { path: 'a.ts' } },
      { phase: 'end', id: 't1', name: 'edit', diff: '+first' },
      { phase: 'start', id: 't2', name: 'edit', args: { path: 'a.ts' } },
      { phase: 'end', id: 't2', name: 'edit', diff: '+second' }
    ])
    expect(listChangedFiles(state)[0]?.diff).toBe('+first\n+second')
  })

  it('caps the accumulated diff, keeping the newest tail', () => {
    const huge = 'x'.repeat(MAX_FILE_DIFF_CHARS)
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'edit', args: { path: 'a.ts' } },
      { phase: 'end', id: 't1', name: 'edit', diff: huge },
      { phase: 'start', id: 't2', name: 'edit', args: { path: 'a.ts' } },
      { phase: 'end', id: 't2', name: 'edit', diff: '+tail' }
    ])
    const diff = listChangedFiles(state)[0]?.diff ?? ''
    expect(diff).toHaveLength(MAX_FILE_DIFF_CHARS)
    expect(diff.endsWith('+tail')).toBe(true)
  })

  it('ignores an unmatched end frame that carries no path of its own', () => {
    const state = runEvents([{ phase: 'end', id: 'ghost', name: 'edit', diff: '+x' }])
    expect(listChangedFiles(state)).toEqual([])
  })

  it('recovers a change when the start frame was missed but the end frame carries args', () => {
    const state = runEvents([{ phase: 'end', id: 'late', name: 'edit', args: { path: 'src/late.ts' }, diff: '+x' }])
    expect(listChangedFiles(state)).toEqual([
      { path: q('src/late.ts'), tools: ['edit'], lastToolCallId: 'late', hasDiff: true, isError: false, diff: '+x' }
    ])
  })

  it('falls back to the end frame args when the start frame had no path field', () => {
    const state = runEvents([
      { phase: 'start', id: 't1', name: 'apply_patch', args: { patch: '*** Begin Patch' } },
      { phase: 'end', id: 't1', name: 'apply_patch', args: { file_path: 'src/app.ts' }, diff: '+x' }
    ])
    expect(listChangedFiles(state)).toHaveLength(1)
    expect(listChangedFiles(state)[0]?.path).toBe(q('src/app.ts'))
  })

  it('keeps update-frame diffs when the start frame was missed', () => {
    const state = runEvents([
      { phase: 'update', id: 't1', name: 'search_replace', args: { path: 'x.ts' }, diff: '+x' },
      { phase: 'end', id: 't1', name: 'search_replace' }
    ])
    expect(listChangedFiles(state)).toEqual([
      { path: q('x.ts'), tools: ['search_replace'], lastToolCallId: 't1', hasDiff: true, isError: false, diff: '+x' }
    ])
  })

  it('never mutates the previous state object', () => {
    const first = runEvents([{ phase: 'start', id: 't1', name: 'edit', args: { path: 'a.ts' } }])
    const before = first.pending.size
    applyToolEvent(first, { phase: 'end', id: 't1', name: 'edit', diff: '+x' }, resolve)
    expect(first.pending.size).toBe(before)
    expect(first.changes.size).toBe(0)
  })
})
