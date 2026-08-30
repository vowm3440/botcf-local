import { afterEach, describe, expect, it } from 'vitest'
import { BotcfClient } from '../src/botcf/adapter.js'
import { extractSiteStatus, getSiteStatus, resetSiteStatus, SITE_STATUS_PATH, siteModelStatus } from '../src/catalog/siteStatus.js'

/** Shape captured live from botcf.com's /pricing status source (2026-08-16). */
const CAPTURED = {
  success: true,
  is_admin: false,
  data: {
    generated_at: 1786854376,
    bucket_seconds: 60,
    bucket_count: 10,
    error_threshold: 20.0,
    refresh_seconds: 15,
    group: '',
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
  afterEach(() => resetSiteStatus())

  it('parses the captured live shape into cells and rates', () => {
    const status = extractSiteStatus(CAPTURED)
    expect(status).not.toBeNull()
    expect(status!.generatedAt).toBe(1786854376_000)
    expect(status!.bucketMs).toBe(60_000)
    expect(status!.bucketCount).toBe(10)
    expect(status!.errorThreshold).toBe(20)
    expect(status!.refreshMs).toBe(15_000)
    expect(status!.models).toHaveLength(2)

    const haiku = status!.models[0]
    expect(haiku.model).toBe('claude-haiku-4-5-20251001')
    expect(haiku.requests).toBe(8)
    expect(haiku.errors).toBe(6)
    expect(haiku.errorRate).toBeCloseTo(0.75)
    expect(haiku.successRate).toBeCloseTo(0.25)
    expect(haiku.throughputTps).toBe(5.5)
    expect(haiku.avgTtftSeconds).toBeNull()
    expect(haiku.cells).toHaveLength(10)
    expect(haiku.cells.slice(-4).map((cell) => cell.state)).toEqual(['idle', 'warn', 'ok', 'error'])
    expect(haiku.cells.at(-4)!.start).toBe(1786853820_000)

    const opus = status!.models[1]
    expect(opus.errorRate).toBe(0)
    expect(opus.avgTtftSeconds).toBe(2.79)
    expect(opus.cells).toHaveLength(10)
    expect(opus.cells.every((cell) => cell.state === 'idle')).toBe(true)
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
    expect(status!.models[0].cells.at(-1)!.start).toBe(1786853820_000)
  })

  it('reports a null error rate for models with no traffic', () => {
    const status = extractSiteStatus({ data: { models: [{ model: 'quiet', requests: 0, errors: 0 }] } })
    expect(status!.models[0].errorRate).toBeNull()
    expect(status!.models[0].successRate).toBeNull()
  })

  it('uses the website threshold instead of marking every partial failure purple', () => {
    const status = extractSiteStatus({
      data: {
        error_threshold: 20,
        models: [{
          model: 'm',
          requests: 30,
          errors: 13,
          buckets: [
            { start: 1, requests: 10, errors: 1, error_rate: 10 },
            { start: 2, requests: 10, errors: 2, error_rate: 20 },
            { start: 3, requests: 10, errors: 10, error_rate: 100 }
          ]
        }]
      }
    })
    expect(status!.models[0].cells.slice(-3).map((cell) => cell.state)).toEqual(['ok', 'warn', 'error'])
  })

  it('applies website monitor-rule overrides', () => {
    const status = extractSiteStatus({
      data: {
        error_threshold: 20,
        monitor_rules: [{ models: ['gpt-*'], force_state: 'error', error_threshold: 5, ttft_seconds: 8.5 }],
        models: [{ model: 'gpt-test', requests: 1, errors: 0, avg_ttft_seconds: 2, buckets: [{ requests: 1, errors: 0 }] }]
      }
    })
    expect(status!.models[0].displayErrorThreshold).toBe(5)
    expect(status!.models[0].avgTtftSeconds).toBe(8.5)
    expect(status!.models[0].cells.every((cell) => cell.state === 'warn')).toBe(true)
  })

  it('matches the pricing page green/gray-only rule for codex-pro', () => {
    const status = extractSiteStatus({
      data: {
        models: [{ model: 'gpt', requests: 1, errors: 1, buckets: [{ requests: 1, errors: 1, error_rate: 100 }] }]
      }
    }, '🚀codex-pro')
    expect(status!.models[0].cells.at(-1)!.state).toBe('ok')
  })

  it('returns the same idle fallback the website uses for a missing model', () => {
    const status = extractSiteStatus({ data: { models: [] } })!
    const model = siteModelStatus(status, 'not-in-response')
    expect(model.model).toBe('not-in-response')
    expect(model.cells).toHaveLength(10)
    expect(model.cells.every((cell) => cell.state === 'idle')).toBe(true)
  })

  it('requests the official pricing resource with the selected group', async () => {
    const paths: string[] = []
    const client = {
      fetchSiteStatus: async (path: string) => {
        paths.push(path)
        return CAPTURED
      }
    } as unknown as BotcfClient

    const result = await getSiteStatus(client, '🚀codex-pro')
    expect(result.path).toBe(SITE_STATUS_PATH)
    expect(paths[0]).toContain(`${SITE_STATUS_PATH}&group=${encodeURIComponent('🚀codex-pro')}&v=`)
  })

  it('keeps website snapshots separate by group', async () => {
    const paths: string[] = []
    const client = {
      fetchSiteStatus: async (path: string) => {
        paths.push(path)
        return CAPTURED
      }
    } as unknown as BotcfClient

    await getSiteStatus(client, 'group-a')
    await getSiteStatus(client, 'group-b')
    expect(paths).toHaveLength(2)
    expect(paths[0]).toContain('group=group-a')
    expect(paths[1]).toContain('group=group-b')
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
