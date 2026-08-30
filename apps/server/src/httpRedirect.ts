import { request as undiciRequest, type Dispatcher } from 'undici'

/** undici's canonical method union — always upper case. */
export type HttpMethod = Dispatcher.HttpMethod

/** The subset of undici request options the updater needs. Deliberately narrow:
 *  there is no `maxRedirections` and no `body` — redirects are followed here
 *  instead (see requestFollowingRedirects), and replaying a body across hops is
 *  unsound, so only bodyless GET/HEAD requests are supported. */
export interface FollowRequestOptions {
  method?: HttpMethod
  headers?: Record<string, string>
  headersTimeout?: number
  bodyTimeout?: number
  signal?: AbortSignal
}

export type UndiciResponse = Awaited<ReturnType<typeof undiciRequest>>

export const DEFAULT_MAX_REDIRECTS = 5

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** Headers that must never follow a redirect to another origin. GitHub sends
 *  asset downloads on to a signed object store that rejects an inherited
 *  Authorization header outright. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

export function isRedirectStatus(statusCode: number): boolean {
  return REDIRECT_STATUS.has(statusCode)
}

/** Pure: resolve a Location header against the URL that produced it. Relative
 *  targets are legal in HTTP, and only http(s) may be followed. */
export function resolveRedirect(currentUrl: string, location: string | string[] | undefined): string {
  const raw = (Array.isArray(location) ? location[0] : location)?.trim()
  if (!raw) throw new Error('重定向响应缺少 Location 头')
  let target: URL
  try {
    target = new URL(raw, currentUrl)
  } catch {
    throw new Error(`无法解析重定向地址: ${raw}`)
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`不支持的重定向协议: ${target.protocol}`)
  }
  return target.toString()
}

/** Pure: 303 always continues as GET; 301/302 do so for anything but GET/HEAD,
 *  which is what browsers and fetch() do. 307/308 preserve the method. */
export function redirectMethod(statusCode: number, method: HttpMethod): HttpMethod {
  if (statusCode === 303) return method === 'HEAD' ? 'HEAD' : 'GET'
  if ((statusCode === 301 || statusCode === 302) && method !== 'GET' && method !== 'HEAD') return 'GET'
  return method
}

/** Pure: strip credentials when a redirect crosses to another origin. */
export function forwardHeaders(
  headers: Record<string, string> | undefined,
  fromUrl: string,
  toUrl: string
): Record<string, string> | undefined {
  if (!headers) return headers
  if (new URL(fromUrl).origin === new URL(toUrl).origin) return headers
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.includes(name.toLowerCase()))
  )
}

/** GET through the Location chain, returning the first non-redirect response.
 *
 *  undici's own `maxRedirections` option cannot be used here. The desktop app
 *  runs this server on Electron's Node runtime (ELECTRON_RUN_AS_NODE), whose
 *  built-in undici v7 has already claimed `Symbol.for('undici.globalDispatcher.1')`
 *  — the same symbol the bundled undici v6 reads — so requests are dispatched
 *  by a v7 Agent that rejects the option outright with "maxRedirections is not
 *  supported, use the redirect interceptor". Every OMP download failed on that.
 *  Following redirects ourselves works on any undici version and still honors
 *  the proxy dispatcher configured in server.ts. */
export async function requestFollowingRedirects(
  url: string,
  options: FollowRequestOptions = {},
  maxRedirects: number = DEFAULT_MAX_REDIRECTS
): Promise<UndiciResponse> {
  let target = url
  let method: HttpMethod = options.method ?? 'GET'
  let headers = options.headers
  for (let hop = 0; ; hop++) {
    const response = await undiciRequest(target, { ...options, method, headers })
    if (!isRedirectStatus(response.statusCode)) return response
    // The socket is only reusable once the (usually empty) 3xx body is drained.
    await response.body.dump()
    if (hop >= maxRedirects) throw new Error(`重定向次数超过 ${maxRedirects} 次: ${url}`)
    const next = resolveRedirect(target, response.headers.location)
    headers = forwardHeaders(headers, target, next)
    method = redirectMethod(response.statusCode, method)
    target = next
  }
}
