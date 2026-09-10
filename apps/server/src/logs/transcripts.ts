/** Disk-backed full transcripts for bounded UI logs (plan §4).
 *
 *  Task runs and terminal sessions keep only a bounded ring buffer in memory
 *  (MAX_RUN_LINES / MAX_TERMINAL_LINES); older lines are dropped there so a
 *  long build or a chatty shell cannot grow the heap. This module gives each
 *  run and session a companion plain-text file under
 *  <dataDir>/logs/{tasks,terminals}/<rootId>/<id>.log that receives every line
 *  as it is produced, so the full output survives the memory cap and stays
 *  readable and paste-able after the ring buffer turned over.
 *
 *  Lifecycle mirrors the in-memory records: the file lives while the run or
 *  session record lives, and is removed when the record is pruned, closed, or
 *  its root leaves the workspace. Files are best-effort by design — a write
 *  failure disables the sink and never breaks the run or the shell itself,
 *  exactly like the draft recovery log. */
import fs from 'node:fs'
import path from 'node:path'

/** Root ids and run/session ids are caller-derived, so they are sanitised
 *  before they become a path segment. */
function safeSegment(value: string): string {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? 'entry' : cleaned
}

export type TranscriptKind = 'tasks' | 'terminals'

function kindDir(dataDir: string, kind: TranscriptKind): string {
  return path.join(dataDir, 'logs', kind)
}

export function transcriptFile(dataDir: string, kind: TranscriptKind, rootId: string, id: string): string {
  return path.join(kindDir(dataDir, kind), safeSegment(rootId), `${safeSegment(id)}.log`)
}

/** Append-only transcript writer for one run or session.
 *
 *  The file is opened lazily on the first line and written synchronously — one
 *  record per line, no buffering — so a child process that floods output is
 *  throttled by disk speed instead of accumulating an unbounded in-memory
 *  queue (the exact failure the bounded ring buffer exists to prevent). */
export class TranscriptSink {
  private fd: number | null = null
  private broken = false
  private closed = false

  constructor(private readonly file: string) {}

  /** Record one transcript line. Never throws; a failed write disables the
   *  sink and the ring buffer keeps serving the UI. */
  append(text: string): void {
    // After close() (a forced kill), late output must not reopen the file:
    // the transcript lifecycle is over even if the child still emits a line.
    if (this.broken || this.closed) return
    try {
      if (this.fd === null) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        this.fd = fs.openSync(this.file, 'a')
      }
      fs.writeSync(this.fd, `${text}\n`, null, 'utf8')
    } catch {
      this.broken = true
      this.close()
    }
  }

  /** Flush and release the file handle; the file itself stays on disk. */
  close(): void {
    this.closed = true
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {
        // Already closed.
      }
      this.fd = null
    }
  }
}

/** Remove one run/session transcript, typically because its in-memory record
 *  was pruned or closed. */
export function removeTranscriptFile(dataDir: string, kind: TranscriptKind, rootId: string, id: string): boolean {
  try {
    fs.unlinkSync(transcriptFile(dataDir, kind, rootId, id))
    return true
  } catch {
    return false
  }
}

/** Forget every transcript of a root that just left the workspace. */
export function clearRootTranscripts(dataDir: string, rootId: string): number {
  let removed = 0
  for (const kind of ['tasks', 'terminals'] as const) {
    const dir = path.join(kindDir(dataDir, kind), safeSegment(rootId))
    try {
      const entries = fs.readdirSync(dir)
      for (const entry of entries) {
        try {
          fs.unlinkSync(path.join(dir, entry))
          removed += 1
        } catch {
          // Best effort, like the draft recovery log.
        }
      }
      fs.rmdirSync(dir)
    } catch {
      // Directory already gone.
    }
  }
  return removed
}

/** Transcripts are ephemeral session data (the in-memory records they mirror
 *  never survive a restart), so a boot sweep drops leftovers of a crashed
 *  process instead of letting them accumulate forever. */
export function clearTranscriptLogs(dataDir: string): number {
  let removed = 0
  for (const kind of ['tasks', 'terminals'] as const) {
    const dir = kindDir(dataDir, kind)
    try {
      const roots = fs.readdirSync(dir)
      for (const root of roots) {
        try {
          const rootDir = path.join(dir, root)
          const files = fs.readdirSync(rootDir)
          for (const file of files) {
            try {
              fs.unlinkSync(path.join(rootDir, file))
              removed += 1
            } catch {
              // Best effort.
            }
          }
          fs.rmdirSync(rootDir)
        } catch {
          // Best effort.
        }
      }
      fs.rmdirSync(dir)
    } catch {
      // Nothing to sweep.
    }
  }
  return removed
}
