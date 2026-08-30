import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  DEFAULT_MAX_REDIRECTS,
  forwardHeaders,
  isRedirectStatus,
  redirectMethod,
  requestFollowingRedirects,
  resolveRedirect
} from '../src/httpRedirect.js'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
    // undici keeps pooled sockets alive; close() alone would wait them out.
    server.closeAllConnections()
  })))
})

/** Records what each hop received so tests can assert method and header rewrites. */
interface Hit {
  url: string
  method: string
  headers: http.IncomingHttpHeaders
}

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, hits: Hit[]) => void): Promise<{ origin: string; hits: Hit[] }> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers })
    handler(req, res, hits)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, hits }
}

describe('resolveRedirect', () => {
  it('resolves a relative Location against the requested URL', () => {
    expect(resolveRedirect('https://github.com/o/r/releases/download/v1/omp.exe', '/cdn/omp.exe'))
      .toBe('https://github.com/cdn/omp.exe')
    expect(resolveRedirect('https://github.com/o/r/releases/download/v1/omp.exe', 'omp-2.exe'))
      .toBe('https://github.com/o/r/releases/download/v1/omp-2.exe')
  })

  it('accepts an absolute cross-origin Location and a duplicated header', () => {
    expect(resolveRedirect('https://github.com/a', 'https://objects.githubusercontent.com/x?token=1'))
      .toBe('https://objects.githubusercontent.com/x?token=1')
    expect(resolveRedirect('https://github.com/a', ['https://objects.githubusercontent.com/x', 'https://evil.test/y']))
      .toBe('https://objects.githubusercontent.com/x')
  })

  it('rejects a missing Location and non-http(s) targets', () => {
    expect(() => resolveRedirect('https://github.com/a', undefined)).toThrow(/Location/)
    expect(() => resolveRedirect('https://github.com/a', '   ')).toThrow(/Location/)
    expect(() => resolveRedirect('https://github.com/a', 'file:///C:/Windows/System32/omp.exe')).toThrow(/协议/)
  })
})

describe('redirectMethod', () => {
  it('downgrades to GET for 303 and for 301/302 on unsafe methods', () => {
    expect(redirectMethod(303, 'POST')).toBe('GET')
    expect(redirectMethod(303, 'HEAD')).toBe('HEAD')
    expect(redirectMethod(301, 'POST')).toBe('GET')
    expect(redirectMethod(302, 'GET')).toBe('GET')
  })

  it('preserves the method for 307/308', () => {
    expect(redirectMethod(307, 'POST')).toBe('POST')
    expect(redirectMethod(308, 'HEAD')).toBe('HEAD')
    expect(redirectMethod(307, 'GET')).toBe('GET')
  })
})

describe('forwardHeaders', () => {
  it('keeps every header within the same origin', () => {
    const headers = { authorization: 'Bearer t', 'user-agent': 'botcf-local' }
    expect(forwardHeaders(headers, 'https://github.com/a', 'https://github.com/b')).toEqual(headers)
  })

  it('drops credentials when the origin changes', () => {
    const headers = { Authorization: 'Bearer t', cookie: 'session=1', 'user-agent': 'botcf-local' }
    expect(forwardHeaders(headers, 'https://github.com/a', 'https://objects.githubusercontent.com/b'))
      .toEqual({ 'user-agent': 'botcf-local' })
  })

  it('treats a port change as a different origin', () => {
    expect(forwardHeaders({ cookie: 'session=1' }, 'http://127.0.0.1:1/a', 'http://127.0.0.1:2/a')).toEqual({})
  })
})

describe('isRedirectStatus', () => {
  it('covers exactly the redirect codes', () => {
    expect([301, 302, 303, 307, 308].every(isRedirectStatus)).toBe(true)
    expect([200, 204, 300, 304, 400, 500].some(isRedirectStatus)).toBe(false)
  })
})

describe('requestFollowingRedirects', () => {
  it('follows a chain and returns the final body', async () => {
    const { origin, hits } = await serve((req, res) => {
      if (req.url === '/asset') { res.writeHead(302, { location: '/cdn/asset' }); res.end(); return }
      if (req.url === '/cdn/asset') { res.writeHead(301, { location: '/cdn/final' }); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('omp-binary')
    })

    const res = await requestFollowingRedirects(`${origin}/asset`, { headers: { 'user-agent': 'botcf-local' } })

    expect(res.statusCode).toBe(200)
    expect(await res.body.text()).toBe('omp-binary')
    expect(hits.map((hit) => hit.url)).toEqual(['/asset', '/cdn/asset', '/cdn/final'])
    expect(hits.at(-1)?.headers['user-agent']).toBe('botcf-local')
  })

  it('returns a non-redirect response untouched', async () => {
    const { origin } = await serve((_req, res) => { res.writeHead(404); res.end('nope') })
    const res = await requestFollowingRedirects(`${origin}/missing`)
    expect(res.statusCode).toBe(404)
    await res.body.dump()
  })

  it('stops after the hop limit instead of looping forever', async () => {
    const { origin, hits } = await serve((req, res) => {
      res.writeHead(302, { location: `/hop${Number(req.url?.replace('/hop', '') ?? 0) + 1}` })
      res.end()
    })

    await expect(requestFollowingRedirects(`${origin}/hop0`, {}, 2)).rejects.toThrow(/重定向次数超过 2 次/)
    expect(hits).toHaveLength(3)
  })

  it('defaults to five hops', async () => {
    const { origin, hits } = await serve((_req, res) => { res.writeHead(302, { location: '/again' }); res.end() })
    await expect(requestFollowingRedirects(`${origin}/start`)).rejects.toThrow(/重定向次数超过 5 次/)
    expect(hits).toHaveLength(DEFAULT_MAX_REDIRECTS + 1)
  })

  it('drops credentials but keeps other headers when redirected to another origin', async () => {
    const target = await serve((_req, res) => { res.writeHead(200); res.end('ok') })
    const entry = await serve((_req, res) => { res.writeHead(302, { location: `${target.origin}/signed` }); res.end() })

    const res = await requestFollowingRedirects(`${entry.origin}/asset`, {
      headers: { 'user-agent': 'botcf-local', authorization: 'Bearer secret' }
    })

    expect(await res.body.text()).toBe('ok')
    expect(target.hits[0]?.headers.authorization).toBeUndefined()
    expect(target.hits[0]?.headers['user-agent']).toBe('botcf-local')
  })

  it('surfaces a redirect without a Location header as an error', async () => {
    const { origin } = await serve((_req, res) => { res.writeHead(302); res.end() })
    await expect(requestFollowingRedirects(`${origin}/asset`)).rejects.toThrow(/Location/)
  })
})
