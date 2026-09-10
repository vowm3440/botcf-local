import { describe, expect, it } from 'vitest'
import { DEFAULT_DEGRADE_INTERVAL_MS, ResourceDegrader, type DegradeActions } from '../src/resource/degrade.js'

function harness(ratios: number[]) {
  const calls: string[] = []
  let capacity = 2
  const actions: DegradeActions = {
    capacity: () => capacity,
    setCapacity: async (next) => {
      capacity = next
      calls.push(`setCapacity:${next}`)
    },
    pauseBackgroundWatchers: () => calls.push('pauseWatchers'),
    resumeBackgroundWatchers: () => calls.push('resumeWatchers')
  }
  const queue = [...ratios]
  const degrader = new ResourceDegrader({
    actions,
    sample: () => ({ availableRatio: queue.length > 0 ? queue.shift()! : 1, selfRssBytes: 0 })
  })
  return { degrader, actions, calls, capacity: () => capacity }
}

describe('resource degrader decisions', () => {
  it('degrades to capacity 1 and pauses watchers below the threshold', async () => {
    const { degrader, calls, capacity } = harness([0.1])
    expect(degrader.state).toBe('normal')
    await degrader.tick()
    expect(degrader.state).toBe('degraded')
    expect(calls).toEqual(['setCapacity:1', 'pauseWatchers'])
    expect(capacity()).toBe(1)
  })

  it('restores the pre-degrade capacity and resumes watchers above the threshold', async () => {
    const { degrader, calls, capacity } = harness([0.1, 0.3])
    await degrader.tick()
    expect(calls).toEqual(['setCapacity:1', 'pauseWatchers'])
    await degrader.tick()
    expect(degrader.state).toBe('normal')
    expect(calls).toEqual(['setCapacity:1', 'pauseWatchers', 'setCapacity:2', 'resumeWatchers'])
    expect(capacity()).toBe(2)
  })

  it('keeps a 5% hysteresis band so the loop does not flap', async () => {
    // 0.17 sits between degrade (0.15) and restore (0.20): never degrades from
    // normal, and never restores once degraded.
    const { degrader, calls } = harness([0.17, 0.17])
    await degrader.tick()
    expect(degrader.state).toBe('normal')
    expect(calls).toEqual([])
    // Force degradation, then hold inside the band.
    const second = harness([0.1, 0.17, 0.17, 0.22])
    await second.degrader.tick()
    await second.degrader.tick()
    expect(second.degrader.state).toBe('degraded')
    expect(second.calls).toEqual(['setCapacity:1', 'pauseWatchers'])
    await second.degrader.tick()
    expect(second.calls).toEqual(['setCapacity:1', 'pauseWatchers'])
    await second.degrader.tick()
    expect(second.degrader.state).toBe('normal')
    expect(second.calls).toEqual(['setCapacity:1', 'pauseWatchers', 'setCapacity:2', 'resumeWatchers'])
    expect(calls).toEqual([])
  })

  it('stays degraded while pressure continues without re-degrading', async () => {
    const { degrader, calls } = harness([0.05, 0.08, 0.12])
    await degrader.tick()
    await degrader.tick()
    await degrader.tick()
    expect(calls).toEqual(['setCapacity:1', 'pauseWatchers'])
  })
})

describe('resource degrader loop scheduling', () => {
  it('schedules at the configured interval and stops cleanly', async () => {
    let scheduled = 0
    let cleared = 0
    const degrader = new ResourceDegrader({
      actions: {
        capacity: () => 2,
        setCapacity: async () => undefined,
        pauseBackgroundWatchers: () => undefined,
        resumeBackgroundWatchers: () => undefined
      },
      intervalMs: 1234,
      timers: {
        setTimeout: () => {
          scheduled += 1
          return scheduled
        },
        clearTimeout: () => {
          cleared += 1
        }
      }
    })
    expect(scheduled).toBe(0)
    degrader.start()
    expect(scheduled).toBe(1)
    degrader.stop()
    expect(cleared).toBe(1)
    degrader.start()
    expect(scheduled).toBe(2)
    degrader.stop()
    expect(DEFAULT_DEGRADE_INTERVAL_MS).toBe(10_000)
  })
})
