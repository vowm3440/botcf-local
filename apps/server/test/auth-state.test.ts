import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState, clearBotcfSession, persistRoute, rearmRoute, setThirdParty } from '../src/appState.js'
import { BotcfClient } from '../src/botcf/adapter.js'
import { getActiveRoute, setActiveRoute } from '../src/proxy/credentialProxy.js'
import { registerApiRoutes } from '../src/routes/api.js'

const secrets = vi.hoisted(() => new Map<string, string>())
vi.mock('../src/db.js', () => ({
  getSecret: (name: string) => secrets.get(name) ?? null,
  putSecret: (name: string, value: string) => { secrets.set(name, value) },
  deleteSecret: (name: string) => { secrets.delete(name) },
  getDb: vi.fn()
}))
vi.mock('../src/secure/store.js', () => ({ seal: (value: string) => value, open: (value: string) => value }))

beforeEach(() => {
  clearBotcfSession()
  setThirdParty({ baseUrl: 'https://previous.invalid', apiKey: 'previous-key', models: ['previous-model'] })
  appState.route = { group: '第三方', modelId: 'previous-model', apiType: 'chat', thinkingLevel: null, routeKey: 'previous', tokenName: 'test', capabilityLabel: 'test', effectiveContext: 100_000 }
  setActiveRoute({ group: '第三方', modelId: 'previous-model', apiType: 'chat', routeKey: 'previous', bearerKey: 'previous-key', baseUrl: 'https://previous.invalid' })
  persistRoute()
})

afterEach(() => {
  clearBotcfSession()
  secrets.clear()
  vi.restoreAllMocks()
})

describe('authentication mode cutover', () => {
  it('revokes the old proxy route and restart route when replacing a third-party provider', async () => {
    const app = Fastify()
    registerApiRoutes(app)
    try {
      const response = await app.inject({ method: 'POST', url: '/api/auth/third-party', payload: { baseUrl: 'https://next.invalid/v1', apiKey: 'next-key', models: 'next-model' } })
      expect(response.statusCode).toBe(200)
      const state = (await app.inject('/api/state')).json()
      expect(state).toMatchObject({ mode: 'third-party', authenticated: true, route: null, thirdParty: { baseUrl: 'https://next.invalid', models: ['next-model'] } })
      expect(getActiveRoute()).toBeNull()
      expect(await rearmRoute()).toBe(false)
      expect(JSON.stringify(state)).not.toContain('next-key')
    } finally {
      await app.close()
    }
  })

  it('activates the newly authenticated BotCF account instead of retaining third-party mode', async () => {
    const user = { id: 2, username: 'next', display_name: 'next', group: 'codex', quota: 0, used_quota: 0, request_count: 0 }
    vi.spyOn(BotcfClient.prototype, 'loginWithAccessToken').mockImplementation(async function (this: BotcfClient, token) {
      this.restoreState({ userId: user.id, accessToken: token, sessionCookie: null })
      return user
    })
    vi.spyOn(BotcfClient.prototype, 'self').mockResolvedValue(user)
    vi.spyOn(BotcfClient.prototype, 'siteStatus').mockRejectedValue(new Error('offline'))
    const app = Fastify()
    registerApiRoutes(app)
    try {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { mode: 'token', token: 'next-account' } })
      expect(response.statusCode).toBe(200)
      const state = (await app.inject('/api/state')).json()
      expect(state).toMatchObject({ mode: 'botcf', authenticated: true, thirdParty: null, route: null, user: { username: 'next' } })
      expect(getActiveRoute()).toBeNull()
      expect(await rearmRoute()).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('keeps the previous authenticated account and route when replacement login fails', async () => {
    const previous = new BotcfClient()
    previous.restoreState({ userId: 1, accessToken: 'previous-account', sessionCookie: null })
    appState.botcf = previous
    appState.thirdParty = null
    vi.spyOn(BotcfClient.prototype, 'loginWithAccessToken').mockImplementation(async function (this: BotcfClient, token) {
      this.restoreState({ userId: null, accessToken: token, sessionCookie: null })
      throw new Error('invalid token')
    })
    const app = Fastify()
    registerApiRoutes(app)
    try {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { mode: 'token', token: 'invalid' } })
      expect(response.statusCode).toBe(500)
      expect(appState.botcf.authenticated).toBe(true)
      expect(appState.botcf.currentUserId).toBe(1)
      expect(getActiveRoute()?.modelId).toBe('previous-model')
    } finally {
      await app.close()
    }
  })
})
