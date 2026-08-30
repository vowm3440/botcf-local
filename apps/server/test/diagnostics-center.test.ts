import { describe, expect, it, vi } from 'vitest'
import { DiagnosticsCenter, MAX_DIAGNOSTICS } from '../src/diagnostics/center.js'
import type { RawDiagnostic } from '../src/diagnostics/parse.js'

function raw(overrides: Partial<RawDiagnostic> = {}): RawDiagnostic {
  return {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    severity: 'error',
    code: null,
    message: 'boom',
    tool: 'tsc',
    ...overrides
  }
}

describe('DiagnosticsCenter', () => {
  it('collapses identical findings into one entry with a count', () => {
    const center = new DiagnosticsCenter()
    center.add({ origin: 'task', source: 'build', diagnostics: [raw(), raw()] })
    const items = center.list()
    expect(items).toHaveLength(1)
    expect(items[0].count).toBe(2)
  })

  it('keeps findings apart when the location differs', () => {
    const center = new DiagnosticsCenter()
    center.add({ origin: 'task', source: 'build', diagnostics: [raw(), raw({ line: 9 })] })
    expect(center.list()).toHaveLength(2)
  })

  it('report() replaces only the same group, so a re-run supersedes itself', () => {
    const center = new DiagnosticsCenter()
    center.report({ origin: 'task', source: 'build', groupId: 'run1', diagnostics: [raw()] })
    center.report({ origin: 'task', source: 'test', groupId: 'run2', diagnostics: [raw({ file: 'test/a.ts' })] })
    center.report({ origin: 'task', source: 'build', groupId: 'run1', diagnostics: [raw({ message: 'new' })] })
    expect(center.list().map((item) => item.message).sort()).toEqual(['boom', 'new'])
  })

  it('resolves tool paths through the caller-supplied resolver', () => {
    const center = new DiagnosticsCenter()
    center.add({
      origin: 'task',
      source: 'build',
      diagnostics: [raw()],
      resolvePath: (file) => `app/${file}`
    })
    expect(center.list()[0].path).toBe('app/src/a.ts')
  })

  it('normalizes separators when no resolver is given', () => {
    const center = new DiagnosticsCenter()
    center.add({ origin: 'task', source: 'build', diagnostics: [raw({ file: 'src\\deep\\a.ts' })] })
    expect(center.list()[0].path).toBe('src/deep/a.ts')
  })

  it('records a problem without a location', () => {
    const center = new DiagnosticsCenter()
    center.note({ origin: 'preview', source: '实时预览', message: '端口被占用' })
    expect(center.list()[0]).toMatchObject({ origin: 'preview', path: null, severity: 'error' })
  })

  it('sorts errors before warnings', () => {
    const center = new DiagnosticsCenter()
    center.add({ origin: 'task', source: 'build', diagnostics: [raw({ severity: 'warning', message: 'warn' })] })
    center.add({ origin: 'task', source: 'build', diagnostics: [raw({ message: 'first' }), raw({ line: 2, message: 'second' })] })
    expect(center.list().map((item) => item.severity)).toEqual(['error', 'error', 'warning'])
  })

  it('puts the most recently seen finding first within a severity', () => {
    vi.useFakeTimers()
    try {
      const center = new DiagnosticsCenter()
      vi.setSystemTime(1_000)
      center.add({ origin: 'task', source: 'build', diagnostics: [raw({ message: 'older' })] })
      vi.setSystemTime(5_000)
      center.add({ origin: 'task', source: 'build', diagnostics: [raw({ line: 2, message: 'newer' })] })
      expect(center.list().map((item) => item.message)).toEqual(['newer', 'older'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('filters by origin and severity', () => {
    const center = new DiagnosticsCenter()
    center.add({ origin: 'task', source: 'build', diagnostics: [raw(), raw({ severity: 'warning', line: 3 })] })
    center.note({ origin: 'agent', source: 'OMP', message: '进程退出' })
    expect(center.list({ origin: 'agent' })).toHaveLength(1)
    expect(center.list({ severity: 'warning' })).toHaveLength(1)
  })

  it('summarizes counts by severity and origin', () => {
    const center = new DiagnosticsCenter()
    center.add({ origin: 'task', source: 'build', diagnostics: [raw(), raw({ severity: 'warning', line: 4 })] })
    center.note({ origin: 'runtime', source: '预览页面', severity: 'info', message: 'hmr' })
    expect(center.summary()).toMatchObject({ total: 3, errors: 1, warnings: 1, infos: 1 })
    expect(center.summary().byOrigin).toMatchObject({ task: 2, runtime: 1 })
  })

  it('clears everything, one origin, or one group', () => {
    const center = new DiagnosticsCenter()
    center.report({ origin: 'task', source: 'build', groupId: 'run1', diagnostics: [raw()] })
    center.note({ origin: 'agent', source: 'OMP', message: '退出' })
    expect(center.clear({ groupId: 'run1' })).toBe(1)
    expect(center.list()).toHaveLength(1)
    center.report({ origin: 'task', source: 'build', groupId: 'run2', diagnostics: [raw()] })
    expect(center.clear({ origin: 'task' })).toBe(1)
    expect(center.list()).toHaveLength(1)
    center.clear()
    expect(center.list()).toEqual([])
  })

  it('stays bounded, dropping the least recently seen entries', () => {
    const center = new DiagnosticsCenter()
    const many = Array.from({ length: MAX_DIAGNOSTICS + 25 }, (_, index) => raw({ line: index + 1 }))
    center.add({ origin: 'task', source: 'build', diagnostics: many })
    expect(center.list()).toHaveLength(MAX_DIAGNOSTICS)
  })

  it('emits changed on additions and on clearing, but not on a no-op clear', () => {
    const center = new DiagnosticsCenter()
    let events = 0
    center.on('changed', () => { events++ })
    center.add({ origin: 'task', source: 'build', diagnostics: [raw()] })
    center.add({ origin: 'task', source: 'build', diagnostics: [] })
    center.clear({ groupId: 'nothing-matches' })
    center.clear()
    expect(events).toBe(2)
  })
})
