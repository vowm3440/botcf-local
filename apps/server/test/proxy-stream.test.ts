import http from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { setActiveRoute, startCredentialProxy } from '../src/proxy/credentialProxy.js'

vi.mock('../src/catalog/modelHealth.js', () => ({ recordProbe: () => {} }))

const originalPort = config.proxyPort
let proxy: FastifyInstance
let upstream: http.Server
let upstreamResponse: ServerResponse
let received: Promise<void>
let closed: Promise<void>
let proxyUrl: string

beforeEach(async () => {
  let receive!: () => void
  let close!: () => void
  received = new Promise<void>((resolve) => { receive = resolve })
  closed = new Promise<void>((resolve) => { close = resolve })
  upstream = http.createServer((req, res) => {
    req.resume()
    upstreamResponse = res
    res.on('close', close)
    receive()
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  config.proxyPort = 0
  setActiveRoute({ routeKey: 'proxy-stream-test', modelId: 'test', group: 'test', apiType: 'chat', bearerKey: 'fake-upstream-key', baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` })
  proxy = await startCredentialProxy()
  proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}/v1/chat/completions`
})

afterEach(async () => {
  upstream.closeAllConnections()
  await proxy.close()
  await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
  config.proxyPort = originalPort
  setActiveRoute(null)
})

describe('credential proxy stream lifetime', () => {
  it.each([false, true])('cancels upstream on client disconnect (headers received: %s)', async (headersReceived) => {
    const abort = new AbortController()
    const pending = fetch(proxyUrl, {
      method: 'POST', signal: abort.signal,
      headers: { authorization: `Bearer ${config.proxyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true })
    }).catch((error: unknown) => error)
    await received
    if (headersReceived) {
      upstreamResponse.writeHead(200, { 'content-type': 'text/event-stream' })
      upstreamResponse.write('data: {"choices":[]}\n\n')
      const response = await pending as Response
      await response.body!.getReader().read()
    }
    abort.abort()
    await closed
    expect(upstreamResponse.destroyed).toBe(true)
    await pending
  })

  it('propagates a truncated upstream body as a read failure rather than clean EOF', async () => {
    const pending = fetch(proxyUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.proxyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true })
    })
    await received
    upstreamResponse.writeHead(200, { 'content-type': 'text/event-stream' })
    upstreamResponse.write('data: {"choices":[]}\n\n')
    const response = await pending
    const body = response.text()
    const failure = expect(body).rejects.toThrow()
    upstreamResponse.destroy()
    await failure
  })
})
