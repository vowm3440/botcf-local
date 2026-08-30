import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotcfClient } from '../src/botcf/adapter.js'
import { appState } from '../src/appState.js'
import { registerApiRoutes } from '../src/routes/api.js'

const originalBotcf = appState.botcf

afterEach(() => {
  appState.botcf = originalBotcf
  vi.restoreAllMocks()
})

describe('GET /api/state', () => {
  it('keeps local state available when the authenticated BotCF session is offline', async () => {
    const client = new BotcfClient()
    client.restoreState({ sessionCookie: 'session=test', accessToken: null, userId: 1 })
    vi.spyOn(client, 'self').mockRejectedValue(new Error('fetch failed'))
    appState.botcf = client

    const app = Fastify()
    registerApiRoutes(app)
    const response = await app.inject({ method: 'GET', url: '/api/state' })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true, authenticated: true, user: null })
  })

  it('reports that startup restoration is still pending', async () => {
    // `route: null` while restoring is not a final answer — the client needs to
    // be able to tell it apart from "no route was ever chosen".
    const client = new BotcfClient()
    client.restoreState({ sessionCookie: 'session=test', accessToken: null, userId: 1 })
    vi.spyOn(client, 'self').mockRejectedValue(new Error('fetch failed'))
    appState.botcf = client
    appState.restoring = true

    const app = Fastify()
    registerApiRoutes(app)
    const response = await app.inject({ method: 'GET', url: '/api/state' })
    await app.close()
    appState.restoring = false

    expect(response.json()).toMatchObject({ restoring: true, route: null })
  })
})
