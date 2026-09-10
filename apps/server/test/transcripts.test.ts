import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TranscriptSink,
  clearRootTranscripts,
  clearTranscriptLogs,
  removeTranscriptFile,
  transcriptFile
} from '../src/logs/transcripts.js'

/** Module-level transcript helpers: path layout, the append-only sink and the
 *  three cleanup entry points (one record, one root, whole logs dir). */

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), label))
}

describe('transcript path layout', () => {
  it('places a record under <dataDir>/logs/<kind>/<rootId>/<id>.log', () => {
    const dir = path.join('data', 'instance')
    expect(transcriptFile(dir, 'tasks', 'r1', 'run42')).toBe(path.join(dir, 'logs', 'tasks', 'r1', 'run42.log'))
    expect(transcriptFile(dir, 'terminals', 'r1', 't9')).toBe(path.join(dir, 'logs', 'terminals', 'r1', 't9.log'))
  })

  it('sanitises caller-derived ids before they become path segments', () => {
    const dir = path.join('data', 'instance')
    const file = transcriptFile(dir, 'tasks', '../escape', 'run/..')
    // Dots are legal filename characters; only separators are escaped, so the
    // resolved path still stays inside <dataDir>/logs/tasks.
    expect(file).toBe(path.join(dir, 'logs', 'tasks', '.._escape', 'run_...log'))
  })
})

describe('TranscriptSink', () => {
  it('appends one record per line and flushes on close', () => {
    const dir = tempDir('botcf-trans-')
    try {
      const file = path.join(dir, 'run.log')
      const sink = new TranscriptSink(file)
      sink.append('first')
      sink.append('second')
      sink.close()
      expect(fs.readFileSync(file, 'utf8')).toBe('first\nsecond\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates parent directories on demand and tolerates double close', () => {
    const dir = tempDir('botcf-trans-')
    try {
      const file = path.join(dir, 'nested', 'deep', 'run.log')
      const sink = new TranscriptSink(file)
      sink.append('x')
      sink.close()
      sink.close()
      expect(fs.existsSync(file)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores appends after close, like late output of a killed child', () => {
    const dir = tempDir('botcf-trans-')
    try {
      const file = path.join(dir, 'run.log')
      const sink = new TranscriptSink(file)
      sink.append('before')
      sink.close()
      // A forced kill can still flush one last line after close(); it must not
      // reopen the file and resurrect a transcript that was just removed.
      sink.append('after')
      expect(fs.readFileSync(file, 'utf8')).toBe('before\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never throws when the file cannot be written', () => {
    const dir = tempDir('botcf-trans-')
    try {
      // A file where the transcript directory would be: every open/write fails.
      const blocker = path.join(dir, 'blocker')
      fs.writeFileSync(blocker, 'x')
      const sink = new TranscriptSink(path.join(blocker, 'run.log'))
      expect(() => sink.append('boom')).not.toThrow()
      expect(() => sink.close()).not.toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('transcript cleanup', () => {
  it('removeTranscriptFile deletes only the named record', () => {
    const dir = tempDir('botcf-trans-')
    try {
      const keep = transcriptFile(dir, 'tasks', 'r1', 'keep')
      const gone = transcriptFile(dir, 'tasks', 'r1', 'gone')
      fs.mkdirSync(path.dirname(keep), { recursive: true })
      fs.writeFileSync(keep, 'a')
      fs.writeFileSync(gone, 'b')
      expect(removeTranscriptFile(dir, 'tasks', 'r1', 'gone')).toBe(true)
      expect(fs.existsSync(gone)).toBe(false)
      expect(fs.existsSync(keep)).toBe(true)
      expect(removeTranscriptFile(dir, 'tasks', 'r1', 'missing')).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clearRootTranscripts removes both kinds for one root only', () => {
    const dir = tempDir('botcf-trans-')
    try {
      for (const rootId of ['gone', 'kept']) {
        const taskFile = transcriptFile(dir, 'tasks', rootId, 'r1')
        const termFile = transcriptFile(dir, 'terminals', rootId, 't1')
        fs.mkdirSync(path.dirname(taskFile), { recursive: true })
        fs.mkdirSync(path.dirname(termFile), { recursive: true })
        fs.writeFileSync(taskFile, 'a')
        fs.writeFileSync(termFile, 'b')
      }
      expect(clearRootTranscripts(dir, 'gone')).toBe(2)
      expect(fs.existsSync(transcriptFile(dir, 'tasks', 'gone', 'r1'))).toBe(false)
      expect(fs.existsSync(transcriptFile(dir, 'terminals', 'gone', 't1'))).toBe(false)
      expect(fs.existsSync(transcriptFile(dir, 'tasks', 'kept', 'r1'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clearTranscriptLogs sweeps every leftover record', () => {
    const dir = tempDir('botcf-trans-')
    try {
      const taskFile = transcriptFile(dir, 'tasks', 'r1', 'run1')
      const termFile = transcriptFile(dir, 'terminals', 'r2', 't1')
      fs.mkdirSync(path.dirname(taskFile), { recursive: true })
      fs.mkdirSync(path.dirname(termFile), { recursive: true })
      fs.writeFileSync(taskFile, 'a')
      fs.writeFileSync(termFile, 'b')
      expect(clearTranscriptLogs(dir)).toBe(2)
      expect(fs.existsSync(taskFile)).toBe(false)
      expect(fs.existsSync(termFile)).toBe(false)
      // Idempotent on an already-empty logs dir.
      expect(clearTranscriptLogs(dir)).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
