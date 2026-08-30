import fs from 'node:fs'
import os from 'node:os'
import { config } from '../config.js'

/** How long a freshly spawned OMP process may take to answer the RPC handshake.
 *
 *  One fixed 10 s window used to cover both halves of that handshake on every
 *  machine. The number was measured on a native cold start and became a bug on
 *  the first machine that wasn't one: the arm64 image under QEMU on an x64 host
 *  emits `ready` well after 10 s, so the health transaction killed a binary that
 *  was merely slow and the container went on answering /health with a dead agent
 *  runtime.
 *
 *  A wider ceiling is safe here for two reasons, and neither of them is "we hope
 *  it's enough":
 *
 *  1. `OmpRpcClient.waitReady()` fails the instant the child exits, so a broken
 *     binary is still reported in milliseconds. The ceiling is only ever paid by
 *     a process that is alive and hasn't spoken yet.
 *  2. It widens only where startup is *known* to be slow — an emulated CPU — and
 *     the `get_state` round trip that proves the loop answers keeps its own,
 *     independent timeout, so a wedged RPC loop cannot hide inside the startup
 *     budget.
 *
 *  Every ceiling is clamped, overrides included (LIMITS): no configuration can
 *  turn the handshake back into an unbounded wait, which is the failure mode
 *  this module exists to end. Observed spawn → ready durations are recorded here
 *  too (`recordReadyDuration`) and surfaced on `/api/omp/status`, so the next
 *  change to these numbers can be read off percentiles instead of guessed. */

export type StartupProfile = 'native' | 'emulated'

export interface StartupBudget {
  /** Ceiling for spawn → `ready` frame. */
  readyMs: number
  /** Ceiling for the `get_state` round trip that proves the loop answers. */
  stateMs: number
  /** Default ceiling for every other RPC call. */
  callMs: number
  /** Ceiling for the post-install smoke prompt (a real model round trip). */
  promptMs: number
  profile: StartupProfile
  /** Why this profile — goes into the startup log line and `/api/omp/status`. */
  reason: string
}

type Ceilings = Omit<StartupBudget, 'profile' | 'reason'>

const PROFILES: Record<StartupProfile, Ceilings> = {
  native: { readyMs: 20_000, stateMs: 5_000, callMs: 30_000, promptMs: 90_000 },
  emulated: { readyMs: 240_000, stateMs: 30_000, callMs: 120_000, promptMs: 300_000 }
}

/** Hard bounds on every ceiling, applied after the profile and after any
 *  override. The upper bound is the gate: a startup budget must stay well under
 *  any CI job timeout, and an operator typo must not produce a hang. */
const LIMITS: Record<keyof Ceilings, readonly [number, number]> = {
  readyMs: [1_000, 600_000],
  stateMs: [1_000, 120_000],
  callMs: [1_000, 300_000],
  promptMs: [5_000, 900_000]
}

export interface StartupBudgetInputs {
  /** `auto` (default) derives the profile from the machine; `native` /
   *  `emulated` force it when detection is wrong. */
  profile?: string
  readyTimeoutMs?: number
  stateTimeoutMs?: number
  arch?: string
  platform?: string
  /** Contents of /proc/cpuinfo, or null where there is no such file. */
  cpuInfo?: string | null
}

function clamp(value: number, key: keyof Ceilings): number {
  const [min, max] = LIMITS[key]
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** True when the kernel reports one architecture and the CPU underneath it is
 *  another — the binfmt_misc / QEMU shape that makes every startup path cost an
 *  order of magnitude more than it does natively.
 *
 *  qemu-user leaves /proc/cpuinfo as the host kernel wrote it, so the mismatch
 *  is directly readable: an aarch64 userland seeing x86 fields (`vendor_id`,
 *  `cpu family`) is running translated instructions, and an x86 userland seeing
 *  `CPU implementer` is the mirror case. */
export function looksEmulated(arch: string, platform: string, cpuInfo: string | null): boolean {
  if (platform !== 'linux' || !cpuInfo) return false
  const x86Host = /^vendor_id\s*:/m.test(cpuInfo) || /^cpu family\s*:/m.test(cpuInfo)
  const armHost = /^CPU implementer\s*:/m.test(cpuInfo) || /^CPU architecture\s*:/m.test(cpuInfo)
  if (x86Host === armHost) return false
  if (arch === 'arm64' || arch === 'arm') return x86Host
  if (arch === 'x64' || arch === 'ia32') return armHost
  return false
}

export function readCpuInfo(): string | null {
  try {
    return fs.readFileSync('/proc/cpuinfo', 'utf8')
  } catch {
    return null
  }
}

/** Pure budget derivation — the whole decision, so a test can assert it without
 *  a container and without an emulated CPU. */
export function resolveStartupBudget(inputs: StartupBudgetInputs = {}): StartupBudget {
  const arch = inputs.arch ?? process.arch
  const platform = inputs.platform ?? process.platform
  const requested = (inputs.profile ?? 'auto').trim().toLowerCase()

  let profile: StartupProfile
  let reason: string
  if (requested === 'native' || requested === 'emulated') {
    profile = requested
    reason = `OMP_STARTUP_PROFILE=${requested}`
  } else if (looksEmulated(arch, platform, inputs.cpuInfo ?? readCpuInfo())) {
    profile = 'emulated'
    reason = `${arch} 用户态运行在异构 CPU 上(QEMU 模拟),启动预算放宽`
  } else {
    profile = 'native'
    reason = `${platform}/${arch} 原生执行`
  }

  const ceilings = PROFILES[profile]
  const overrides: Partial<Ceilings> = {}
  if (inputs.readyTimeoutMs !== undefined) overrides.readyMs = inputs.readyTimeoutMs
  if (inputs.stateTimeoutMs !== undefined) overrides.stateMs = inputs.stateTimeoutMs
  const overridden = Object.keys(overrides).length > 0

  return {
    readyMs: clamp(overrides.readyMs ?? ceilings.readyMs, 'readyMs'),
    stateMs: clamp(overrides.stateMs ?? ceilings.stateMs, 'stateMs'),
    callMs: clamp(ceilings.callMs, 'callMs'),
    promptMs: clamp(ceilings.promptMs, 'promptMs'),
    profile,
    reason: overridden ? `${reason};环境变量覆盖超时` : reason
  }
}

let cached: StartupBudget | null = null

/** Process-wide budget, derived once. `/proc/cpuinfo` and the architecture do
 *  not change while the server runs. */
export function ompStartupBudget(inputs?: StartupBudgetInputs): StartupBudget {
  if (inputs) return resolveStartupBudget(inputs)
  if (!cached) {
    cached = resolveStartupBudget({
      profile: config.ompStartup.profile,
      readyTimeoutMs: config.ompStartup.readyTimeoutMs,
      stateTimeoutMs: config.ompStartup.stateTimeoutMs
    })
  }
  return cached
}

/** Observed spawn → ready durations. Bounded ring, newest last. */
const MAX_SAMPLES = 50
let readyDurations: readonly number[] = []

export function recordReadyDuration(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return
  readyDurations = [...readyDurations, Math.round(ms)].slice(-MAX_SAMPLES)
}

export function resetReadyDurations(): void {
  readyDurations = []
}

export interface ReadyDurationStats {
  samples: number
  p50: number | null
  p95: number | null
  max: number | null
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

/** The evidence behind the ceilings above: what startup actually cost on this
 *  machine. A budget change should quote these, not a hunch. */
export function readyDurationStats(): ReadyDurationStats {
  const sorted = [...readyDurations].sort((a, b) => a - b)
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null
  }
}

/** One line for the startup log, so a slow machine is diagnosable from stdout. */
export function describeStartupBudget(budget: StartupBudget = ompStartupBudget()): string {
  const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`
  const host = `${os.platform()}/${process.arch}`
  return `启动预算 ${budget.profile} (${host}): ready ≤ ${seconds(budget.readyMs)}, get_state ≤ ${seconds(budget.stateMs)} — ${budget.reason}`
}
