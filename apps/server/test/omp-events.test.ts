import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmpUpdater } from '../src/omp/updater.js'
import { registerOmpRoutes } from '../src/routes/omp.js'

describe('OMP event stream', () => {
  const apps: Array<ReturnType<typeof Fastify>> = []

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()))
  })

  it('forwards updater events and removes the listener when the client closes', async () => {
    const app = Fastify()
    apps.push(app)
    const updater = new OmpUpdater({
      isIdle: () => true,
      onIdleOnce: () => undefined,
      healthProbe: async () => true,
      log: () => undefined
    })
    registerOmpRoutes(app, updater)
    await app.listen({ host: '127.0.0.1', port: 0 })

    const controller = new AbortController()
    const response = await fetch(`${app.listeningOrigin}/api/omp/events`, { signal: controller.signal })
    const reader = response.body!.getReader()
    await reader.read()
    expect(updater.listenerCount('update')).toBe(1)

    updater.emit('update', { phase: 'switched', version: 'v2', state: { ...updater.getState(), currentVersion: 'v2' } })
    const frame = new TextDecoder().decode((await reader.read()).value)
    expect(frame).toContain('"type":"omp_update"')
    expect(frame).toContain('"phase":"switched"')
    expect(frame).toContain('"currentVersion":"v2"')

    controller.abort()
    await reader.cancel().catch(() => undefined)
    await vi.waitFor(() => expect(updater.listenerCount('update')).toBe(0))
  })
})
