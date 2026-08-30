import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  contentTypeFor,
  directoryIndexHtml,
  errorPageHtml,
  escapeHtml,
  injectClientScript,
  isHtmlPath,
  looksLikeRoute
} from '../src/preview/mime.js'
import { PREVIEW_CLIENT_PATH, PREVIEW_CLIENT_TAG, PREVIEW_EVENTS_PATH } from '../src/preview/reloadClient.js'
import { StaticPreviewServer, parseRequestPath } from '../src/preview/staticPreview.js'

const temps: string[] = []
let running: StaticPreviewServer | null = null

function makeSite(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-preview-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return dir
}

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** Raw request so tests can set Host (fetch forbids it) and skip redirects. */
function request(
  port: number,
  urlPath: string,
  options: { host?: string; method?: string; origin?: string } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${port}` }
    if (options.origin) headers.origin = options.origin
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: options.method ?? 'GET', headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

async function serve(files: Record<string, string>, entry: string | null = 'index.html'): Promise<{ port: number; server: StaticPreviewServer; root: string }> {
  const root = makeSite(files)
  const server = new StaticPreviewServer({ root, entry })
  running = server
  const port = await server.start()
  return { port, server, root }
}

afterEach(async () => {
  await running?.stop()
  running = null
})

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

describe('mime helpers', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(contentTypeFor('a/b.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('style.CSS')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('bundle.mjs')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('binary.bin')).toBe('application/octet-stream')
    expect(contentTypeFor('noext')).toBe('application/octet-stream')
  })

  it('recognises html paths', () => {
    expect(isHtmlPath('/a/index.htm')).toBe(true)
    expect(isHtmlPath('/a/index.html')).toBe(true)
    expect(isHtmlPath('/a/main.js')).toBe(false)
  })

  it('treats extensionless paths as client routes', () => {
    expect(looksLikeRoute('/')).toBe(true)
    expect(looksLikeRoute('/settings/profile')).toBe(true)
    expect(looksLikeRoute('/assets/app.js')).toBe(false)
  })

  it('injects the client before </body>, then </html>, then appends', () => {
    expect(injectClientScript('<html><body>x</body></html>', '<s>')).toBe('<html><body>x<s>\n</body></html>')
    expect(injectClientScript('<html>x</html>', '<s>')).toBe('<html>x<s>\n</html>')
    expect(injectClientScript('bare', '<s>')).toBe('bare\n<s>')
  })

  it('escapes html in generated pages', () => {
    expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;')
    const index = directoryIndexHtml('', [{ name: '<script>.txt', type: 'file' }])
    expect(index).not.toContain('<script>.txt')
    expect(index).toContain('&lt;script&gt;.txt')
    expect(errorPageHtml(404, 'nope')).toContain('404')
  })

  it('links the parent directory only in subdirectories', () => {
    expect(directoryIndexHtml('', [])).not.toContain('../')
    expect(directoryIndexHtml('sub/deep', [])).toContain('../')
  })
})

describe('parseRequestPath', () => {
  it('strips the query and decodes the path', () => {
    expect(parseRequestPath('/a/b%20c.js?x=1#h')?.relPath).toBe('a/b c.js')
    expect(parseRequestPath('/')?.relPath).toBe('')
  })

  it('rejects malformed encoding and NUL bytes', () => {
    expect(parseRequestPath('/%zz')).toBeNull()
    expect(parseRequestPath('/a%00b')).toBeNull()
  })

  it('normalizes backslashes so containment sees one form', () => {
    expect(parseRequestPath('/a\\b')?.relPath).toBe('a/b')
  })
})

describe('StaticPreviewServer', () => {
  it('serves the index with the reload client injected', async () => {
    const { port } = await serve({ 'index.html': '<html><body>hi</body></html>' })
    const res = await request(port, '/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('hi')
    expect(res.body).toContain(PREVIEW_CLIENT_TAG)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('serves assets with their content type and no injection', async () => {
    const { port } = await serve({ 'index.html': '<html></html>', 'app.css': 'body{color:red}' })
    const res = await request(port, '/app.css')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(res.body).toBe('body{color:red}')
  })

  it('serves the reload client script', async () => {
    const { port } = await serve({ 'index.html': '<html></html>' })
    const res = await request(port, PREVIEW_CLIENT_PATH)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(res.body).toContain(PREVIEW_EVENTS_PATH)
  })

  it('falls back to the entry for client-routed paths but 404s for assets', async () => {
    const { port } = await serve({ 'index.html': '<html><body>spa</body></html>' })
    const route = await request(port, '/settings/profile')
    expect(route.status).toBe(200)
    expect(route.body).toContain('spa')
    const asset = await request(port, '/missing.js')
    expect(asset.status).toBe(404)
  })

  it('lists a directory that has no index', async () => {
    const { port } = await serve({ 'docs/readme.md': '# hi' }, null)
    const res = await request(port, '/docs/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('readme.md')
  })

  it('refuses paths that escape the workdir', async () => {
    const { port } = await serve({ 'index.html': '<html></html>' })
    const res = await request(port, '/../../etc/hosts')
    // The URL layer may normalize ../ away; either way nothing outside leaks.
    expect([403, 404, 200]).toContain(res.status)
    expect(res.body).not.toContain('127.0.0.1\tlocalhost')
    const encoded = await request(port, '/%2e%2e%2f%2e%2e%2fpackage.json')
    expect([403, 404]).toContain(encoded.status)
  })

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const { port } = await serve({ 'index.html': '<html></html>' })
    const res = await request(port, '/', { host: 'evil.example.com' })
    expect(res.status).toBe(403)
  })

  it('rejects a cross-origin Origin header', async () => {
    const { port } = await serve({ 'index.html': '<html></html>' })
    const res = await request(port, '/', { origin: 'https://evil.example.com' })
    expect(res.status).toBe(403)
  })

  it('rejects methods other than GET/HEAD', async () => {
    const { port } = await serve({ 'index.html': '<html></html>' })
    const res = await request(port, '/', { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('GET, HEAD')
  })

  it('answers HEAD with headers and no body', async () => {
    const { port } = await serve({ 'index.html': '<html><body>hi</body></html>' })
    const res = await request(port, '/', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.body).toBe('')
  })

  it('pushes reload frames to attached event clients', async () => {
    const { port, server } = await serve({ 'index.html': '<html></html>' })
    const frames: string[] = []
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: PREVIEW_EVENTS_PATH, headers: { host: `127.0.0.1:${port}` } },
        resolve
      )
      req.on('error', reject)
      req.end()
    })
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => frames.push(chunk))
    await vi.waitFor(() => expect(server.clientCount).toBe(1))
    server.broadcast('css')
    await vi.waitFor(() => expect(frames.join('')).toContain('"type":"css"'))
    stream.destroy()
  })
})
