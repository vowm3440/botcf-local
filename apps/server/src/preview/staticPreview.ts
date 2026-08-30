import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { locateInsideRoot } from '../fsContainment.js'
import { isTrustedLocalRequest } from '../secure/localRequest.js'
import {
  contentTypeFor,
  directoryIndexHtml,
  errorPageHtml,
  injectClientScript,
  isHtmlPath,
  looksLikeRoute
} from './mime.js'
import {
  PREVIEW_CLIENT_PATH,
  PREVIEW_CLIENT_SOURCE,
  PREVIEW_CLIENT_TAG,
  PREVIEW_EVENTS_PATH
} from './reloadClient.js'
import { ReloadKind } from './watcher.js'

/** Built-in preview host for projects that have no dev server of their own.
 *  Serves the workdir over loopback, injects the live-reload client into every
 *  HTML response, and pushes reload/CSS-swap frames over SSE.
 *
 *  Hardening: loopback Host/Origin guard (blocks DNS rebinding, same rule as the
 *  control API), GET/HEAD only, and every path resolved through the workdir
 *  containment check so symlinks cannot serve files from outside the project. */

/** HTML larger than this is streamed without client injection. */
const MAX_INJECT_BYTES = 4 * 1024 * 1024

const INDEX_CANDIDATES = ['index.html', 'index.htm'] as const

export interface StaticPreviewOptions {
  root: string
  host?: string
  /** 0 (default) picks an ephemeral port. */
  port?: number
  /** Workdir-relative html used for client-routed paths (SPA fallback). */
  entry?: string | null
}

interface UrlTarget {
  /** Decoded, workdir-relative request path (no leading slash). */
  relPath: string
}

/** Decode a request URL into a workdir-relative path. Rejects malformed
 *  percent-encoding and NUL bytes rather than passing them to the filesystem. */
export function parseRequestPath(url: string): UrlTarget | null {
  let pathname: string
  try {
    pathname = new URL(url, 'http://127.0.0.1').pathname
  } catch {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const relPath = decoded.replace(/^\/+/, '')
  // Backslashes are path separators on Windows; keep them out of the request so
  // containment sees one canonical form.
  return { relPath: relPath.replace(/\\/g, '/') }
}

export class StaticPreviewServer {
  private server: http.Server | null = null
  private clients = new Set<http.ServerResponse>()
  private boundPort: number | null = null
  private readonly root: string
  private readonly host: string
  private readonly requestedPort: number
  private entry: string | null

  constructor(options: StaticPreviewOptions) {
    this.root = options.root
    this.host = options.host ?? '127.0.0.1'
    this.requestedPort = options.port ?? 0
    this.entry = options.entry ?? null
  }

  get port(): number | null {
    return this.boundPort
  }

  get clientCount(): number {
    return this.clients.size
  }

  async start(): Promise<number> {
    if (this.boundPort !== null) return this.boundPort
    const server = http.createServer((req, res) => {
      this.handle(req, res)
    })
    server.on('clientError', (_err, socket) => {
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.requestedPort, this.host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error('预览服务器未能绑定端口')
    }
    this.server = server
    this.boundPort = address.port
    return address.port
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.end()
    this.clients.clear()
    const server = this.server
    this.server = null
    this.boundPort = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Push a reload (or CSS hot-swap) to every attached preview page. */
  broadcast(kind: ReloadKind): void {
    const frame = `data: ${JSON.stringify({ type: kind, at: Date.now() })}\n\n`
    for (const client of this.clients) {
      try {
        client.write(frame)
      } catch {
        // Client vanished mid-write; the close handler removes it.
      }
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!isTrustedLocalRequest(req.headers.host, req.headers.origin)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('仅允许同源回环访问')
      return
    }
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
      res.end('预览服务只接受 GET/HEAD')
      return
    }
    const target = parseRequestPath(req.url ?? '/')
    if (!target) {
      this.sendHtml(res, 400, errorPageHtml(400, '请求路径无法解码'), method)
      return
    }
    if (`/${target.relPath}` === PREVIEW_CLIENT_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(method === 'HEAD' ? undefined : PREVIEW_CLIENT_SOURCE)
      return
    }
    if (`/${target.relPath}` === PREVIEW_EVENTS_PATH) {
      this.attachEventClient(req, res)
      return
    }
    this.serveFile(target.relPath, res, method)
  }

  private attachEventClient(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    const keepalive = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        /* the close handler cleans up */
      }
    }, 25_000)
    keepalive.unref?.()
    const cleanup = (): void => {
      clearInterval(keepalive)
      this.clients.delete(res)
    }
    req.once('close', cleanup)
    res.once('close', cleanup)
  }

  private serveFile(relPath: string, res: http.ServerResponse, method: string): void {
    const located = locateInsideRoot(this.root, relPath)
    if (located.status === 'outside') {
      this.sendHtml(res, 403, errorPageHtml(403, '路径越出工作目录'), method)
      return
    }
    if (located.status === 'missing') {
      this.serveFallback(relPath, res, method)
      return
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(located.target)
    } catch {
      this.serveFallback(relPath, res, method)
      return
    }
    if (stat.isDirectory()) {
      this.serveDirectory(relPath, located.target, res, method)
      return
    }
    if (isHtmlPath(located.target) && stat.size <= MAX_INJECT_BYTES) {
      this.sendHtml(res, 200, this.readInjectedHtml(located.target), method)
      return
    }
    res.writeHead(200, {
      'content-type': contentTypeFor(located.target),
      'content-length': String(stat.size),
      'cache-control': 'no-store',
      'accept-ranges': 'none'
    })
    if (method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(located.target)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  private serveDirectory(relPath: string, dir: string, res: http.ServerResponse, method: string): void {
    for (const candidate of INDEX_CANDIDATES) {
      const file = path.join(dir, candidate)
      try {
        if (fs.statSync(file).isFile()) {
          this.sendHtml(res, 200, this.readInjectedHtml(file), method)
          return
        }
      } catch {
        // Not present — try the next candidate, then fall back to the listing.
      }
    }
    let entries: Array<{ name: string; type: 'dir' | 'file' }> = []
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .map((dirent) => ({ name: dirent.name, type: dirent.isDirectory() ? ('dir' as const) : ('file' as const) }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    } catch {
      this.sendHtml(res, 500, errorPageHtml(500, '目录无法读取'), method)
      return
    }
    this.sendHtml(res, 200, directoryIndexHtml(relPath, entries, PREVIEW_CLIENT_TAG), method)
  }

  /** Client-routed paths fall back to the html entry so SPA routes render. */
  private serveFallback(relPath: string, res: http.ServerResponse, method: string): void {
    if (this.entry && looksLikeRoute(`/${relPath}`)) {
      const located = locateInsideRoot(this.root, this.entry)
      if (located.status === 'ok') {
        this.sendHtml(res, 200, this.readInjectedHtml(located.target), method)
        return
      }
    }
    this.sendHtml(res, 404, errorPageHtml(404, `未找到 /${relPath}`), method)
  }

  private readInjectedHtml(file: string): string {
    try {
      return injectClientScript(fs.readFileSync(file, 'utf8'), PREVIEW_CLIENT_TAG)
    } catch (err: unknown) {
      return errorPageHtml(500, `读取失败: ${err instanceof Error ? err.message : String(err)}`, PREVIEW_CLIENT_TAG)
    }
  }

  private sendHtml(res: http.ServerResponse, status: number, html: string, method: string): void {
    const body = Buffer.from(html, 'utf8')
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store'
    })
    res.end(method === 'HEAD' ? undefined : body)
  }
}
