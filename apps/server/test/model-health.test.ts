import { describe, expect, it } from 'vitest'
import { buildHealth, cellState } from '../src/catalog/modelHealth.js'

describe('cellState', () => {
  it('maps traffic and failures to the four cell colors', () => {
    expect(cellState(0, 0)).toBe('idle')
    expect(cellState(3, 0)).toBe('ok')
    expect(cellState(4, 1)).toBe('warn')
    expect(cellState(2, 2)).toBe('error')
    expect(cellState(1, 5)).toBe('error')
  })
})

describe('buildHealth', () => {
  const NOW = 100_000
  const BUCKET = 10_000
  const COUNT = 4 // window = [60_000, 100_000)

  it('returns all-idle cells and a null fault rate without traffic', () => {
    const health = buildHealth([], NOW, BUCKET, COUNT)
    expect(health.cells).toHaveLength(COUNT)
    expect(health.cells.every((cell) => cell.state === 'idle')).toBe(true)
    expect(health.total).toBe(0)
    expect(health.faultRate).toBeNull()
  })

  it('assigns samples to buckets and clamps the now-edge into the last cell', () => {
    const health = buildHealth(
      [
        { ts: 60_000, ok: true },   // first cell start
        { ts: 69_999, ok: true },   // still first cell
        { ts: 70_000, ok: false },  // second cell
        { ts: 100_000, ok: true }   // exactly now -> last cell
      ],
      NOW, BUCKET, COUNT
    )
    expect(health.cells[0]).toMatchObject({ total: 2, failed: 0, state: 'ok' })
    expect(health.cells[1]).toMatchObject({ total: 1, failed: 1, state: 'error' })
    expect(health.cells[2]).toMatchObject({ total: 0, failed: 0, state: 'idle' })
    expect(health.cells[3]).toMatchObject({ total: 1, failed: 0, state: 'ok' })
  })

  it('drops samples outside the window', () => {
    const health = buildHealth(
      [
        { ts: 59_999, ok: false },
        { ts: 100_001, ok: false }
      ],
      NOW, BUCKET, COUNT
    )
    expect(health.total).toBe(0)
    expect(health.faultRate).toBeNull()
  })

  it('computes the fault rate over the whole window', () => {
    const health = buildHealth(
      [
        { ts: 61_000, ok: true },
        { ts: 71_000, ok: false },
        { ts: 81_000, ok: true },
        { ts: 91_000, ok: true }
      ],
      NOW, BUCKET, COUNT
    )
    expect(health.total).toBe(4)
    expect(health.failed).toBe(1)
    expect(health.faultRate).toBeCloseTo(0.25)
  })

  it('marks mixed buckets as warn', () => {
    const health = buildHealth(
      [
        { ts: 61_000, ok: true },
        { ts: 62_000, ok: false }
      ],
      NOW, BUCKET, COUNT
    )
    expect(health.cells[0].state).toBe('warn')
  })

  it('reports bucket geometry so the UI can label cells', () => {
    const health = buildHealth([], NOW, BUCKET, COUNT)
    expect(health.bucketMs).toBe(BUCKET)
    expect(health.windowMs).toBe(BUCKET * COUNT)
    expect(health.cells[0].start).toBe(60_000)
    expect(health.cells[3].start).toBe(90_000)
  })
})
