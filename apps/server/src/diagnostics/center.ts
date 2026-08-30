import { EventEmitter } from 'node:events'
import type { DiagnosticSeverity, RawDiagnostic } from './parse.js'

/** The errors & diagnostics center: one place that collects everything that went
 *  wrong, from wherever it came from.
 *
 *  Sources feed it: task runs (parsed compiler/linter/test output), the live
 *  preview (dev-server failures and page runtime errors), the agent runtime (RPC
 *  and update failures) and the control server itself. The panel then shows one
 *  ranked list, and clicking an entry opens the file at the line.
 *
 *  Properties that keep it useful rather than noisy:
 *   - identical findings collapse into one entry with a `count`, so a watch-mode
 *     build that reprints the same error does not scroll the list away;
 *   - each entry remembers the group (task run id, preview session) that produced
 *     it, so a new run can replace exactly its own previous findings;
 *   - the store is capped and evicts the least recently seen entries;
 *   - paths are resolved by the *caller*, which knows the cwd the tool ran in —
 *     this module stays free of workspace state so it can be tested in isolation. */

export type DiagnosticOrigin = 'task' | 'preview' | 'agent' | 'runtime' | 'server'

export interface Diagnostic {
  id: string
  origin: DiagnosticOrigin
  /** Human label for where it came from: task name, "预览", "OMP" … */
  source: string
  tool: string | null
  severity: DiagnosticSeverity
  /** Qualified workspace path (`<rootName>/<relative>`), or null when unknown. */
  path: string | null
  line: number | null
  column: number | null
  code: string | null
  message: string
  /** First seen. */
  at: number
  /** Last seen; an identical finding updates this instead of duplicating. */
  lastAt: number
  count: number
  /** Producer id (task run id, preview start) for scoped clearing. */
  groupId: string | null
}

export const MAX_DIAGNOSTICS = 500

export interface DiagnosticSummary {
  total: number
  errors: number
  warnings: number
  infos: number
  byOrigin: Record<DiagnosticOrigin, number>
}

export interface ReportInput {
  origin: DiagnosticOrigin
  source: string
  groupId?: string | null
  diagnostics: readonly RawDiagnostic[]
  /** Turns a tool-printed path into a qualified workspace path. */
  resolvePath?: (file: string) => string | null
}

export interface NoteInput {
  origin: DiagnosticOrigin
  source: string
  severity?: DiagnosticSeverity
  message: string
  groupId?: string | null
  path?: string | null
  line?: number | null
  code?: string | null
  tool?: string | null
}

const ORIGINS: DiagnosticOrigin[] = ['task', 'preview', 'agent', 'runtime', 'server']

function emptyByOrigin(): Record<DiagnosticOrigin, number> {
  return { task: 0, preview: 0, agent: 0, runtime: 0, server: 0 }
}

/** Shape of a finding before the store adds identity and counters. */
type DiagnosticShape = Omit<Diagnostic, 'id' | 'at' | 'lastAt' | 'count'>

/** Identity of a finding: same place, same message, same producer. JSON keeps the
 *  fields unambiguous, so a message containing a separator cannot collide. */
function keyOf(entry: DiagnosticShape): string {
  return JSON.stringify([entry.origin, entry.source, entry.path, entry.line, entry.column, entry.message])
}

function severityRank(severity: DiagnosticSeverity): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2
}

export class DiagnosticsCenter extends EventEmitter {
  private entries = new Map<string, Diagnostic>()
  private nextId = 1

  list(filter: { origin?: DiagnosticOrigin; severity?: DiagnosticSeverity; groupId?: string } = {}): Diagnostic[] {
    return [...this.entries.values()]
      .filter((entry) => !filter.origin || entry.origin === filter.origin)
      .filter((entry) => !filter.severity || entry.severity === filter.severity)
      .filter((entry) => !filter.groupId || entry.groupId === filter.groupId)
      // Errors first, then newest — the order the panel wants to render.
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.lastAt - a.lastAt)
  }

  summary(): DiagnosticSummary {
    const byOrigin = emptyByOrigin()
    let errors = 0
    let warnings = 0
    let infos = 0
    for (const entry of this.entries.values()) {
      byOrigin[entry.origin] += 1
      if (entry.severity === 'error') errors += 1
      else if (entry.severity === 'warning') warnings += 1
      else infos += 1
    }
    return { total: this.entries.size, errors, warnings, infos, byOrigin }
  }

  /** Replace a group's findings with a fresh set — what a re-run should do. */
  report(input: ReportInput): Diagnostic[] {
    if (input.groupId) this.dropGroup(input.groupId)
    return this.add(input)
  }

  /** Add findings without clearing anything (streaming during a run). */
  add(input: ReportInput): Diagnostic[] {
    const resolve = input.resolvePath ?? ((file: string) => file.replace(/\\/g, '/'))
    const added: Diagnostic[] = []
    for (const raw of input.diagnostics) {
      added.push(
        this.upsert({
          origin: input.origin,
          source: input.source,
          tool: raw.tool,
          severity: raw.severity,
          path: resolve(raw.file),
          line: raw.line,
          column: raw.column,
          code: raw.code,
          message: raw.message,
          groupId: input.groupId ?? null
        })
      )
    }
    if (added.length > 0) this.changed()
    return added
  }

  /** A problem without a source location: a failed run, a dead process, a
   *  configuration error. Just as important as a parsed compiler error. */
  note(input: NoteInput): Diagnostic {
    const entry = this.upsert({
      origin: input.origin,
      source: input.source,
      tool: input.tool ?? null,
      severity: input.severity ?? 'error',
      path: input.path ?? null,
      line: input.line ?? null,
      column: null,
      code: input.code ?? null,
      message: input.message.slice(0, 1_000),
      groupId: input.groupId ?? null
    })
    this.changed()
    return entry
  }

  clear(filter: { groupId?: string; origin?: DiagnosticOrigin } = {}): number {
    const before = this.entries.size
    if (!filter.groupId && !filter.origin) {
      this.entries.clear()
    } else {
      for (const [key, entry] of this.entries) {
        if (filter.groupId && entry.groupId !== filter.groupId) continue
        if (filter.origin && entry.origin !== filter.origin) continue
        this.entries.delete(key)
      }
    }
    const removed = before - this.entries.size
    if (removed > 0) this.changed()
    return removed
  }

  private upsert(shape: DiagnosticShape): Diagnostic {
    const key = keyOf(shape)
    const now = Date.now()
    const existing = this.entries.get(key)
    if (existing) {
      const updated: Diagnostic = { ...existing, ...shape, lastAt: now, count: existing.count + 1 }
      this.entries.set(key, updated)
      return updated
    }
    const entry: Diagnostic = { ...shape, id: `d${this.nextId++}`, at: now, lastAt: now, count: 1 }
    this.entries.set(key, entry)
    this.evict()
    return entry
  }

  /** Keep the store bounded, dropping the least recently seen entries. */
  private evict(): void {
    if (this.entries.size <= MAX_DIAGNOSTICS) return
    const ordered = [...this.entries.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)
    for (const [key] of ordered.slice(0, this.entries.size - MAX_DIAGNOSTICS)) {
      this.entries.delete(key)
    }
  }

  private dropGroup(groupId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.groupId === groupId) this.entries.delete(key)
    }
  }

  private changed(): void {
    this.emit('changed', this.summary())
  }
}

export const diagnosticsCenter = new DiagnosticsCenter()

export { ORIGINS as DIAGNOSTIC_ORIGINS }
