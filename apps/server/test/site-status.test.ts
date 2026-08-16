import { describe, expect, it } from 'vitest'
import { extractSiteStatus } from '../src/catalog/siteStatus.js'

/** Shape captured live from botcf.com's /pricing status source (2026-08-16). */
const CAPTURED = {
  success: true,
  is_admin: false,
  data: {
    generated_at: 1786854376,
    bucket_seconds: 60,
    bucket_count: 10,
    error_threshold: 20.0,
    models: [
      {
        model: 'claude-haiku-4-5-20251001',
        requests: 8,
        successes: 2,
        errors: 6,
        success_rate: 25.0,
        error_rate: 75.0,
        avg_ttft_seconds: null,
        throughput_tps: 5.5,
        buckets: [
          { start: 1786853820, requests: 0, successes: 0, errors: 0, error_rate: null },
          { start: 1786853880, requests: 8, successes: 2, errors: 6, error_rate: 75.0 },
          { start: 1786853940, requests: 3, successes: 3, errors: 0, error_rate: 0.0 },
          { start: 1786854000, requests: 2, successes: 0, errors: 2, error_rate: 100.0 }
        ],
        display_state: 'auto',
        display_error_threshold: 20.0
      },
      {
        model: 'claude-opus-4-6-thinking',
        requests: 1,
        successes: 1,
        errors: 0,
        success_rate: 100.0,
        error_rate: 0.0,
        avg_ttft_seconds: 2.79,
        throughput_tps: 40.7,
        buckets: []
      }
    ]
  }
}

describe('extractSiteStatus', () => {
  it('parses the captured live shape into cells and rates', () => {
    const status = extractSiteStatus(CAPTURED)
    expect(status).not.toBeNull()
    expect(status!.generatedAt).toBe(1786854376_000)
    expect(status!.bucketMs).toBe(60_000)
    expect(status!.errorThreshold).toBe(20)
    expect(status!.models).toHaveLength(2)

    const haiku = status!.models[0]
    expect(haiku.model).toBe('claude-haiku-4-5-20251001')
    expect(haiku.requests).toBe(8)
    expect(haiku.errors).toBe(6)
    expect(haiku.errorRate).toBeCloseTo(0.75)
    expect(haiku.throughputTps).toBe(5.5)
    expect(haiku.avgTtftSeconds).toBeNull()
    expect(haiku.cells.map((cell) => cell.state)).toEqual(['idle', 'warn', 'ok', 'error'])
    expect(haiku.cells[0].start).toBe(1786853820_000)

    const opus = status!.models[1]
    expect(opus.errorRate).toBe(0)
    expect(opus.avgTtftSeconds).toBe(2.79)
    expect(opus.cells).toEqual([])
  })

  it('accepts model_name as an alias and derives the error rate from counts', () => {
    const status = extractSiteStatus({
      data: {
        models: [{ model_name: 'gpt-4o', requests: 4, errors: 1 }]
      }
    })
    expect(status!.models[0].model).toBe('gpt-4o')
    expect(status!.models[0].errorRate).toBeCloseTo(0.25)
  })

  it('passes through bucket starts that are already in milliseconds', () => {
    const status = extractSiteStatus({
      data: {
        generated_at: 1786854376_000,
        models: [{ model: 'm', requests: 0, errors: 0, buckets: [{ start: 1786853820_000, requests: 1, errors: 0 }] }]
      }
    })
    expect(status!.generatedAt).toBe(1786854376_000)
    expect(status!.models[0].cells[0].start).toBe(1786853820_000)
  })

  it('reports a null error rate for models with no traffic', () => {
    const status = extractSiteStatus({ data: { models: [{ model: 'quiet', requests: 0, errors: 0 }] } })
    expect(status!.models[0].errorRate).toBeNull()
  })

  it('returns null for junk payloads', () => {
    expect(extractSiteStatus(null)).toBeNull()
    expect(extractSiteStatus('nope')).toBeNull()
    expect(extractSiteStatus({ data: {} })).toBeNull()
    expect(extractSiteStatus({ data: { models: 'not-array' } })).toBeNull()
  })

  it('skips model entries without a usable name', () => {
    const status = extractSiteStatus({ data: { models: [{ requests: 1 }, { model: 'ok', requests: 1, errors: 0 }] } })
    expect(status!.models.map((m) => m.model)).toEqual(['ok'])
  })
})
