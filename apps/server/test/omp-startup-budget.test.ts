import { describe, expect, it } from 'vitest'
import { looksEmulated, readyDurationStats, recordReadyDuration, resetReadyDurations, resolveStartupBudget } from '../src/omp/startupBudget.js'

/** /proc/cpuinfo as an x86 host writes it — what a qemu-aarch64 userland sees. */
const X86_CPUINFO = [
  'processor\t: 0',
  'vendor_id\t: GenuineIntel',
  'cpu family\t: 6',
  'model name\t: 13th Gen Intel(R) Core(TM) i7-13700H',
  'flags\t\t: fpu vme de pse tsc msr'
].join('\n')

/** /proc/cpuinfo on a real arm64 machine. */
const ARM_CPUINFO = [
  'processor\t: 0',
  'BogoMIPS\t: 48.00',
  'Features\t: fp asimd evtstrm aes',
  'CPU implementer\t: 0x41',
  'CPU architecture: 8',
  'CPU part\t: 0xd0c'
].join('\n')

describe('looksEmulated', () => {
  it('flags an arm64 userland running on an x86 host', () => {
    expect(looksEmulated('arm64', 'linux', X86_CPUINFO)).toBe(true)
  })

  it('does not flag a real arm64 machine', () => {
    expect(looksEmulated('arm64', 'linux', ARM_CPUINFO)).toBe(false)
  })

  it('does not flag a real x64 machine', () => {
    expect(looksEmulated('x64', 'linux', X86_CPUINFO)).toBe(false)
  })

  it('flags the mirror case: an x64 userland on an arm host', () => {
    expect(looksEmulated('x64', 'linux', ARM_CPUINFO)).toBe(true)
  })

  it('stays native where there is no /proc/cpuinfo to read', () => {
    expect(looksEmulated('arm64', 'linux', null)).toBe(false)
    expect(looksEmulated('arm64', 'win32', X86_CPUINFO)).toBe(false)
  })

  it('stays native when the file is unreadable or says nothing either way', () => {
    expect(looksEmulated('arm64', 'linux', 'processor\t: 0\n')).toBe(false)
    // Both vocabularies present: not a mismatch we can act on.
    expect(looksEmulated('arm64', 'linux', `${X86_CPUINFO}\n${ARM_CPUINFO}`)).toBe(false)
  })
})

describe('resolveStartupBudget', () => {
  const native = { arch: 'x64', platform: 'linux', cpuInfo: X86_CPUINFO }
  const emulated = { arch: 'arm64', platform: 'linux', cpuInfo: X86_CPUINFO }

  it('keeps a native machine on a short ready budget', () => {
    const budget = resolveStartupBudget(native)
    expect(budget.profile).toBe('native')
    expect(budget.readyMs).toBe(20_000)
    expect(budget.stateMs).toBe(5_000)
  })

  it('widens the ready budget past the old fixed 10 s window under emulation', () => {
    const budget = resolveStartupBudget(emulated)
    expect(budget.profile).toBe('emulated')
    // The arm64 QEMU image reached `ready` after the old 10 s ceiling.
    expect(budget.readyMs).toBeGreaterThan(10_000)
    expect(budget.readyMs).toBe(240_000)
  })

  it('keeps get_state on its own, much shorter ceiling than startup', () => {
    for (const inputs of [native, emulated]) {
      const budget = resolveStartupBudget(inputs)
      expect(budget.stateMs).toBeLessThan(budget.readyMs)
    }
  })

  it('honours an explicit profile over detection', () => {
    expect(resolveStartupBudget({ ...emulated, profile: 'native' }).profile).toBe('native')
    expect(resolveStartupBudget({ ...native, profile: 'emulated' }).profile).toBe('emulated')
    expect(resolveStartupBudget({ ...native, profile: 'nonsense' }).profile).toBe('native')
  })

  it('applies env overrides and records that it did', () => {
    const budget = resolveStartupBudget({ ...native, readyTimeoutMs: 45_000, stateTimeoutMs: 9_000 })
    expect(budget.readyMs).toBe(45_000)
    expect(budget.stateMs).toBe(9_000)
    expect(budget.reason).toContain('覆盖')
  })

  it('clamps every ceiling, so no override can restore an unbounded wait', () => {
    const huge = resolveStartupBudget({ ...native, readyTimeoutMs: 86_400_000, stateTimeoutMs: 86_400_000 })
    expect(huge.readyMs).toBe(600_000)
    expect(huge.stateMs).toBe(120_000)
    const tiny = resolveStartupBudget({ ...native, readyTimeoutMs: 1, stateTimeoutMs: 1 })
    expect(tiny.readyMs).toBe(1_000)
    expect(tiny.stateMs).toBe(1_000)
  })
})

describe('ready duration stats', () => {
  it('reports the percentiles a budget change should be argued from', () => {
    resetReadyDurations()
    expect(readyDurationStats()).toEqual({ samples: 0, p50: null, p95: null, max: null })
    for (const ms of [1_200, 900, 30_000, 1_100, 1_000]) recordReadyDuration(ms)
    const stats = readyDurationStats()
    expect(stats.samples).toBe(5)
    expect(stats.p50).toBe(1_100)
    expect(stats.max).toBe(30_000)
    expect(stats.p95).toBe(30_000)
  })

  it('ignores nonsense samples and keeps the ring bounded', () => {
    resetReadyDurations()
    recordReadyDuration(Number.NaN)
    recordReadyDuration(-1)
    expect(readyDurationStats().samples).toBe(0)
    for (let i = 0; i < 120; i++) recordReadyDuration(i)
    const stats = readyDurationStats()
    expect(stats.samples).toBe(50)
    expect(stats.max).toBe(119)
  })
})
