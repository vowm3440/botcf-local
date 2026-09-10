import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { request as undiciRequest } from 'undici'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { redact } from '../secure/redact.js'
import { recordContextError } from '../catalog/capability.js'
import { recordProbe } from '../catalog/modelHealth.js'

export interface ActiveRoute {
  routeKey: string
  apiType: 'responses' | 'chat' | 'messages'
  bearerKey: string
  modelId: string
  group: string
  /** Third-party provider origin; BotCF's base URL when absent. */
  baseUrl?: string
}

/** In-memory only — the key is sealed in SQLite, decrypted once per route switch,
 *  and handed to nothing but the outbound Authorization header. */
let activeRoute: ActiveRoute | null = null

export function setActiveRoute(route: ActiveRoute | null): void {
  activeRoute = route
}

export function getActiveRoute(): ActiveRoute | null {
  return activeRoute
}

const PATH_TO_API: Record<string, ActiveRoute['apiType']> = {
  '/v1/chat/completions': 'chat',
  '/v1/responses': 'responses',
  '/v1/messages': 'messages'
}

function upstreamUrl(route: ActiveRoute, path: string): string {
  // Anthropic-compatible messages live at /v1/messages on the bare domain;
  // OpenAI-compatible paths live under /v1. Both resolve to the same absolute path.
  return (route.baseUrl ?? config.botcfBaseUrl) + path
}

/** Extract the true limit from "maximum context length is 200000 tokens ..." style errors. */
export function parseContextLimit(errorBody: string): number | undefined {
  const m = errorBody.match(/maximum context length is (\d{4,9})/i) ?? errorBody.match(/context[^0-9]{0,20}(\d{5,9})\s*tokens/i)
  return m ? Number(m[1]) : undefined
}

function isContextError(status: number, body: string): boolean {
  return status === 400 && /context length|context window|maximum context|too many tokens/i.test(body)
}


export function isProxyRequestAuthorized(authorization: string | undefined, apiKey: string | undefined, expected: string): boolean {
  const supplied = authorization?.replace(/^Bearer\s+/i, '') ?? apiKey ?? ''
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export function requestedModel(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const model = Reflect.get(body, 'model')
  return typeof model === 'string' ? model : undefined
}
async function forward(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
  const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined
  if (!isProxyRequestAuthorized(authorization, apiKey, config.proxyToken)) {
    reply.code(401).send({ error: { message: '本地凭据代理认证失败' } })
    return
  }
  const route = activeRoute
  if (!route) {
    reply.code(503).send({ error: { message: '尚未选择分组/模型:请先在控制台完成路由配置' } })
    return
  }
  const apiType = PATH_TO_API[req.url.split('?')[0]]
  if (apiType && apiType !== route.apiType) {
    reply.code(409).send({ error: { message: `当前路由是 ${route.apiType} 接口,收到的却是 ${apiType} 请求` } })
    return
  }
  const model = requestedModel(req.body)
  if (model !== route.modelId) {
    reply.code(409).send({ error: { message: `请求模型必须与当前路由一致: ${route.modelId}` } })
    return
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${route.bearerKey}`
  }
  if (route.apiType === 'messages') {
    headers['x-api-key'] = route.bearerKey
    headers['anthropic-version'] = '2023-06-01'
  }

  const abort = new AbortController()
  req.raw.on('aborted', () => abort.abort())
  const abortOnClose = (): void => {
    if (!reply.raw.writableFinished) abort.abort()
  }
  reply.raw.on('close', abortOnClose)

  /** Health probe bookkeeping must never break the data path. */
  const probe = (ok: boolean, status: number): void => {
    try {
      recordProbe(route.group, route.modelId, ok, status)
    } catch {
      // SQLite hiccups are irrelevant to the in-flight request.
    }
  }

  try {
    const upstream = await undiciRequest(upstreamUrl(route, req.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body ?? {}),
      signal: abort.signal
    })

    if (upstream.statusCode >= 400) {
      probe(false, upstream.statusCode)
      const text = await upstream.body.text()
      if (isContextError(upstream.statusCode, text)) {
        const next = recordContextError(route.routeKey, parseContextLimit(text))
        req.log.warn(`route ${route.routeKey} hit upstream context limit; effective_context lowered to ${next}`)
      }
      reply.code(upstream.statusCode)
      reply.header('content-type', upstream.headers['content-type'] ?? 'application/json')
      reply.send(redact(text))
      return
    }

    probe(true, upstream.statusCode)
    reply.raw.writeHead(upstream.statusCode, {
      'content-type': (upstream.headers['content-type'] as string) ?? 'application/json',
      'cache-control': 'no-cache'
    })
    for await (const chunk of upstream.body) {
      reply.raw.write(chunk)
    }
    reply.raw.end()
  } catch (err: unknown) {
    if (abort.signal.aborted) {
      if (!reply.raw.headersSent) reply.code(499).send({ error: { message: '客户端已中止请求' } })
      return
    }
    probe(false, 0)
    req.log.error(redact(err instanceof Error ? err.message : String(err)))
    if (!reply.raw.headersSent) {
      reply.code(502).send({ error: { message: '上游请求失败' } })
    } else {
      // Do not turn a truncated upstream stream into a successful EOF.
      reply.raw.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  } finally {
    reply.raw.off('close', abortOnClose)
  }
}

/** The only process boundary OMP ever talks to. Binds strictly to loopback. */
export async function startCredentialProxy(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: 'info', redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '***' } },
    bodyLimit: 64 * 1024 * 1024
  })

  app.get('/health', async () => ({ status: 'ok', route: activeRoute ? { apiType: activeRoute.apiType, model: activeRoute.modelId } : null }))

  app.post('/v1/chat/completions', forward)
  app.post('/v1/responses', forward)
  app.post('/v1/messages', forward)

  await app.listen({ host: '127.0.0.1', port: config.proxyPort })
  return app
}
