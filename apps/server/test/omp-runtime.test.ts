import { describe, expect, it } from 'vitest'
import { restartRuntime, type RuntimeControl } from '../src/omp/runtime.js'

/** The invariant this module exists for: a restart is only finished once the
 *  active route has been re-applied *and* verified. OMP restores its own
 *  persisted model on start, so a restart that stops at the handshake leaves the
 *  agent on a provider nobody selected — which is how switching the primary root
 *  started answering 409 while the UI still showed the chosen route. */

interface Behaviour {
  available?: boolean
  start?: boolean
  handshake?: boolean
  hasRoute?: boolean
  /** true applies, false refuses, an Error is a failed `get_state` verification. */
  applyRoute?: boolean | Error
  lastError?: string | null
}

interface Recorder {
  control: RuntimeControl
  /** Every step that ran, in order — including the ones that failed. */
  steps: string[]
  failures: string[]
}

function recorder(behaviour: Behaviour = {}): Recorder {
  const steps: string[] = []
  const failures: string[] = []
  const record = <T>(name: string, produce: () => Promise<T>) => (): Promise<T> => {
    steps.push(name)
    return produce()
  }
  const control: RuntimeControl = {
    available: () => behaviour.available ?? true,
    stop: record('stop', () => Promise.resolve()),
    start: record('start', () => Promise.resolve(behaviour.start ?? true)),
    handshake: record('handshake', () => Promise.resolve(behaviour.handshake ?? true)),
    lastError: () => behaviour.lastError ?? null,
    hasRoute: () => behaviour.hasRoute ?? true,
    applyRoute: record('applyRoute', () => {
      const outcome = behaviour.applyRoute ?? true
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
    }),
    onFailure: (error) => failures.push(error)
  }
  return { control, steps, failures }
}

describe('restartRuntime', () => {
  it('runs stop → start → handshake → apply route, in that order', async () => {
    const { control, steps } = recorder()
    expect(await restartRuntime(control)).toEqual({ status: 'restarted', error: null })
    expect(steps).toEqual(['stop', 'start', 'handshake', 'applyRoute'])
  })

  it('counts as restarted with no route yet — a fresh install has nothing to apply', async () => {
    const { control, steps } = recorder({ hasRoute: false })
    expect(await restartRuntime(control)).toEqual({ status: 'restarted', error: null })
    expect(steps).toEqual(['stop', 'start', 'handshake'])
  })

  it('reports a missing binary as unavailable rather than as a failure', async () => {
    const { control, steps, failures } = recorder({ available: false })
    expect(await restartRuntime(control)).toEqual({ status: 'unavailable', error: null })
    expect(steps).toEqual(['stop'])
    expect(failures).toEqual([])
  })

  it('does not report success when the route could not be re-applied', async () => {
    const { control, steps, failures } = recorder({ applyRoute: false })
    expect(await restartRuntime(control)).toEqual({ status: 'failed', error: '活动路由未能重新应用' })
    // Stopped again on the way out: direct mode still honours the active route, an
    // agent process carrying the wrong model does not.
    expect(steps).toEqual(['stop', 'start', 'handshake', 'applyRoute', 'stop'])
    expect(failures).toHaveLength(1)
  })

  it('turns a failed state verification into a failure, not a silent restart', async () => {
    const { control, steps } = recorder({
      applyRoute: new Error('OMP 状态校验失败: 期望 botcf-chat/grok-4.6, 实际 anthropic/claude-opus-4-8')
    })
    const result = await restartRuntime(control)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('状态校验失败')
    expect(steps).toEqual(['stop', 'start', 'handshake', 'applyRoute', 'stop'])
  })

  it('reports the protocol error when the handshake fails', async () => {
    const { control, steps } = recorder({ handshake: false, lastError: 'RPC 握手失败: 等待 ready 帧超时' })
    expect(await restartRuntime(control)).toEqual({ status: 'failed', error: 'RPC 握手失败: 等待 ready 帧超时' })
    expect(steps).not.toContain('applyRoute')
  })

  it('reports a process that would not start', async () => {
    const { control, steps } = recorder({ start: false })
    expect(await restartRuntime(control)).toEqual({ status: 'failed', error: 'OMP 启动失败' })
    expect(steps).not.toContain('handshake')
  })
})
