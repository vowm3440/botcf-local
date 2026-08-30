import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appState } from '../src/appState.js'
import { BotcfClient, BotcfLogItem } from '../src/botcf/adapter.js'
import { registerApiRoutes } from '../src/routes/api.js'

// The adapter routes upstream calls through undici's proxy-aware fetch, not
// the global fetch, so tests must intercept the undici export.
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fetchMock
}))

function log(overrides: Partial<BotcfLogItem> = {}): BotcfLogItem {
  return {
    id: 1,
    type: 2,
    created_at: 1_786_683_806,
    model_name: 'gpt-5',
    token_name: 'normal-token',
    group: 'default',
    quota: 250_000,
    prompt_tokens: 120,
    completion_tokens: 30,
    use_time: 1.25,
    is_stream: true,
    ...overrides
  }
}

function envelope(items: BotcfLogItem[], total = items.length): Response {
  return new Response(JSON.stringify({ success: true, message: '', data: { items, total } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

async function buildApp() {
  const app = Fastify({ logger: false })
  registerApiRoutes(app)
  await app.ready()
  return app
}

const originalBotcf = appState.botcf

afterEach(() => {
  appState.botcf = originalBotcf
  fetchMock.mockReset()
  vi.restoreAllMocks()
})

describe('BotcfClient logs', () => {
  it('appends pagination and filter parameters to /api/log/self', async () => {
    fetchMock.mockImplementation(async () => envelope([]))

    await new BotcfClient().logs({
      page: 3,
      pageSize: 40,
      tokenName: 'token, "quoted"',
      modelName: 'gpt-5',
      group: 'codex plus',
      startTs: 100,
      endTs: 200
    })

    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.pathname).toBe('/api/log/self')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      p: '3',
      page_size: '40',
      type: '0',
      token_name: 'token, "quoted"',
      model_name: 'gpt-5',
      group: 'codex plus',
      start_timestamp: '100',
      end_timestamp: '200'
    })
  })

  it('aggregates pages and stops at maxPages', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get('p'))
      return envelope([log({ id: page + 1 })], 50)
    })

    const result = await new BotcfClient().fetchAllLogs({ page: 0, pageSize: 1 }, 3)

    expect(result.items.map((item) => item.id)).toEqual([1, 2, 3])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('never retains more than 10,000 log items', async () => {
    const pageItems = Array.from({ length: 6_000 }, (_, index) => log({ id: index + 1 }))
    fetchMock.mockImplementation(async () => envelope(pageItems, 50_000))

    const result = await new BotcfClient().fetchAllLogs({ page: 0, pageSize: 100 }, 100)

    expect(result.items).toHaveLength(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('/api/logs', () => {
  it('validates pagination and timestamps', async () => {
    const app = await buildApp()
    try {
      expect((await app.inject('/api/logs?page=-1')).statusCode).toBe(400)
      expect((await app.inject('/api/logs?pageSize=101')).statusCode).toBe(400)
      expect((await app.inject('/api/logs?startTs=not-a-number')).statusCode).toBe(400)
      expect((await app.inject('/api/logs?startTs=200&endTs=100')).statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('returns a filtered, paged envelope', async () => {
    appState.botcf = {
      fetchAllLogs: vi.fn(async () => ({
        items: [
          log({ id: 1, token_name: 'alpha', model_name: 'gpt-5', group: 'g1', created_at: 110 }),
          log({ id: 2, token_name: 'beta', model_name: 'gpt-5', group: 'g1', created_at: 120 }),
          log({ id: 3, token_name: 'alpha-2', model_name: 'claude', group: 'g2', created_at: 130 }),
          log({ id: 4, type: 7, token_name: 'alpha', model_name: 'gpt-5', group: 'g1', created_at: 140 })
        ],
        total: 4
      }))
    } as unknown as BotcfClient

    const app = await buildApp()
    try {
      const response = await app.inject('/api/logs?page=0&pageSize=1&tokenName=alpha&modelName=gpt&group=g1&startTs=100&endTs=125')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        success: true,
        items: [{ ...log({ id: 1, token_name: 'alpha', model_name: 'gpt-5', group: 'g1', created_at: 110 }), quotaUsd: 0.5 }],
        total: 1,
        page: 0,
        pageSize: 1
      })
    } finally {
      await app.close()
    }
  })
})

describe('/api/logs/export', () => {
  it('returns a BOM-prefixed CSV with headers and escaped fields', async () => {
    appState.botcf = {
      fetchAllLogs: vi.fn(async () => ({
        items: [log({ token_name: 'team, "quoted"' })],
        total: 1
      })),
      siteStatus: vi.fn(async () => ({ quotaPerUnit: 500_000, turnstileCheck: false }))
    } as unknown as BotcfClient

    const app = await buildApp()
    try {
      const response = await app.inject('/api/logs/export?format=csv')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/csv')
      expect(response.headers['content-disposition']).toContain('attachment;')
      expect(response.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
      expect(response.body).toContain('时间,分组,令牌,模型,prompt_tokens,completion_tokens,quota,折算 USD,耗时(秒),是否流式')
      expect(response.body).toContain('"team, ""quoted"""')
    } finally {
      await app.close()
    }
  })

  it('returns JSON as a downloadable array with converted quota', async () => {
    appState.botcf = {
      fetchAllLogs: vi.fn(async () => ({ items: [log({ id: 9 })], total: 1 })),
      siteStatus: vi.fn(async () => ({ quotaPerUnit: 500_000, turnstileCheck: false }))
    } as unknown as BotcfClient

    const app = await buildApp()
    try {
      const response = await app.inject('/api/logs/export?format=json&startTs=1786600000&endTs=1786700000')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(response.headers['content-disposition']).toContain('botcf-logs-2026-08-13-to-2026-08-14.json')
      expect(response.json()).toEqual([{ ...log({ id: 9 }), quotaUsd: 0.5 }])
    } finally {
      await app.close()
    }
  })
})
