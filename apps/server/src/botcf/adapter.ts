import { fetch as undiciFetch } from 'undici'
import { config } from '../config.js'
import { redact } from '../secure/redact.js'

export interface BotcfUser {
  id: number
  username: string
  display_name: string
  group: string
  quota: number
  used_quota: number
  request_count: number
}

export interface BotcfTokenItem {
  id: number
  name: string
  key: string
  status: number
  group: string
  remain_quota: number
  used_quota: number
  unlimited_quota: boolean
  expired_time: number
}

export interface BotcfLogItem {
  id: number
  type: number // 2 = consumption, 7 = system/login
  created_at: number
  model_name: string
  token_name: string
  group: string
  quota: number
  prompt_tokens: number
  completion_tokens: number
  use_time: number
  is_stream: boolean
}

export interface LogQuery {
  page: number
  pageSize: number
  tokenName?: string
  modelName?: string
  group?: string
  startTs?: number
  endTs?: number
}

export interface LogPage {
  items: BotcfLogItem[]
  total: number
}

const MAX_LOG_PAGES = 100
const MAX_LOG_ITEMS = 10_000

export interface CreateTokenOptions {
  name: string
  group: string
  remainQuota?: number
  unlimitedQuota?: boolean
}

export class BotcfError extends Error {
  constructor(message: string, readonly status?: number) {
    super(redact(message))
    this.name = 'BotcfError'
  }
}

interface ApiEnvelope<T> {
  success: boolean
  message: string
  data: T
}

/** Proxy-aware fetch for all BotCF upstream calls. Node's built-in fetch
 *  ignores both HTTP(S)_PROXY and the undici global dispatcher configured in
 *  server.ts, so a machine that reaches botcf.com only through a system proxy
 *  failed every login with a bare "fetch failed". The npm undici fetch honors
 *  the EnvHttpProxyAgent, and network failures surface their real cause. */
async function botcfFetch(url: string, init?: Parameters<typeof undiciFetch>[1]): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
  try {
    return await undiciFetch(url, init)
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null
    const code = (cause as NodeJS.ErrnoException | null)?.code
    const message = cause?.message ?? (error instanceof Error ? error.message : String(error))
    throw new BotcfError(`无法连接 BotCF: ${[code, message].filter(Boolean).join(' ')}`)
  }
}

/** Thin client for BotCF's New API management endpoints, verified against the
 *  live contract on 2026-08-14 (docs/botcf-api-contract.md). Supports two auth
 *  modes: password login (session cookie) and pasted system access token. */
export class BotcfClient {
  private sessionCookie: string | null = null
  private accessToken: string | null = null
  private userId: number | null = null

  get authenticated(): boolean {
    return this.userId !== null && (this.sessionCookie !== null || this.accessToken !== null)
  }

  get currentUserId(): number | null {
    return this.userId
  }

  exportState(): { sessionCookie: string | null; accessToken: string | null; userId: number | null } {
    return { sessionCookie: this.sessionCookie, accessToken: this.accessToken, userId: this.userId }
  }

  restoreState(state: { sessionCookie: string | null; accessToken: string | null; userId: number | null }): void {
    this.sessionCookie = state.sessionCookie
    this.accessToken = state.accessToken
    this.userId = state.userId
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'botcf-local/0.1'
    }
    if (this.sessionCookie) h.Cookie = this.sessionCookie
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`
    if (this.userId !== null) h['New-Api-User'] = String(this.userId)
    return h
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await botcfFetch(config.botcfBaseUrl + path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie && setCookie.includes('session=')) {
      this.sessionCookie = setCookie.split(';')[0]
    }
    let payload: ApiEnvelope<T>
    try {
      payload = (await res.json()) as ApiEnvelope<T>
    } catch {
      throw new BotcfError(`BotCF 返回了非 JSON 响应 (HTTP ${res.status})`, res.status)
    }
    if (!res.ok || payload.success === false) {
      throw new BotcfError(payload.message || `BotCF 请求失败 (HTTP ${res.status})`, res.status)
    }
    return payload.data
  }

  /** POST /api/user/login — password mode. Password lives only in this call's scope. */
  async loginWithPassword(username: string, password: string): Promise<BotcfUser> {
    this.sessionCookie = null
    this.accessToken = null
    this.userId = null
    const user = await this.request<BotcfUser>('POST', '/api/user/login', { username, password })
    this.userId = user.id
    return user
  }

  /** Token-paste mode: a system access token created in the BotCF console. */
  async loginWithAccessToken(token: string): Promise<BotcfUser> {
    this.sessionCookie = null
    this.accessToken = token
    this.userId = null
    const user = await this.self()
    this.userId = user.id
    return user
  }

  /** GET /api/user/self — balance (quota), used_quota, default group. */
  async self(): Promise<BotcfUser> {
    return this.request<BotcfUser>('GET', '/api/user/self')
  }

  /** GET /api/user/models — flat list of model ids available to this user. */
  async models(): Promise<string[]> {
    return this.request<string[]>('GET', '/api/user/models')
  }

  /** GET /api/token/ — paged key list. Normal users CAN read this (verified). */
  async listTokens(): Promise<BotcfTokenItem[]> {
    const items: BotcfTokenItem[] = []
    for (let page = 0; page < 10; page++) {
      const data = await this.request<{ items: BotcfTokenItem[]; total: number; page_size: number }>(
        'GET',
        `/api/token/?p=${page}&size=100`
      )
      items.push(...(data.items ?? []))
      if (items.length >= (data.total ?? 0) || (data.items ?? []).length === 0) break
    }
    return items
  }

  /** POST /api/token/ — create a key bound to a group. Empty group string means
   *  "user default group", so callers must pass the real group name (verified:
   *  creating with group "" yields an unbound key). */
  async createToken(opts: CreateTokenOptions): Promise<BotcfTokenItem | null> {
    return (await this.request<BotcfTokenItem | null>('POST', '/api/token/', {
      name: opts.name,
      group: opts.group,
      remain_quota: opts.remainQuota ?? 500_000,
      unlimited_quota: opts.unlimitedQuota ?? true,
      expired_time: -1,
      model_limits_enabled: false,
      model_limits: '',
      cross_group_retry: false
    })) ?? null
  }


  /** BotCF one-time key reveal endpoint used by its own console integrations. */
  async revealTokenKey(id: number): Promise<string> {
    const data = await this.request<unknown>('POST', `/api/token/${id}/key`)
    if (typeof data === 'string') return data
    if (data && typeof data === 'object') {
      for (const field of ['key', 'apiKey', 'api_key', 'secret']) {
        const value = Reflect.get(data, field)
        if (typeof value === 'string') return value
      }
    }
    throw new BotcfError('BotCF 密钥揭示接口未返回 Key')
  }

  /** Delete one of this application's own keys before rotating it. */
  async deleteToken(id: number): Promise<void> {
    await this.request<unknown>('DELETE', `/api/token/${id}`)
  }

  /** GET /api/log/self/stat — aggregate used quota + rpm/tpm. */
  async usageStat(): Promise<{ quota: number; rpm: number; tpm: number }> {
    return this.request<{ quota: number; rpm: number; tpm: number }>('GET', '/api/log/self/stat?type=0')
  }

  /** GET /api/log/self — per-request log entries (tokens, model, quota cost). */
  async logs(query: LogQuery): Promise<LogPage> {
    const params = new URLSearchParams({
      p: String(query.page),
      page_size: String(query.pageSize),
      type: '0'
    })
    if (query.tokenName) params.set('token_name', query.tokenName)
    if (query.modelName) params.set('model_name', query.modelName)
    if (query.group) params.set('group', query.group)
    if (query.startTs !== undefined) params.set('start_timestamp', String(query.startTs))
    if (query.endTs !== undefined) params.set('end_timestamp', String(query.endTs))

    const data = await this.request<{ items?: BotcfLogItem[]; total?: number }>('GET', `/api/log/self?${params}`)
    return { items: data.items ?? [], total: data.total ?? 0 }
  }

  /** Aggregate paged logs for filtering/export, bounded to avoid accidental
   *  unbounded reads when an upstream total is missing or inaccurate. */
  async fetchAllLogs(query: LogQuery, maxPages = MAX_LOG_PAGES): Promise<LogPage> {
    const pageLimit = Math.max(1, Math.min(Math.trunc(maxPages), MAX_LOG_PAGES))
    const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize), 100))
    const firstPage = Math.max(0, Math.trunc(query.page))
    const items: BotcfLogItem[] = []
    let total = 0

    for (let offset = 0; offset < pageLimit && items.length < MAX_LOG_ITEMS; offset++) {
      const page = await this.logs({ ...query, page: firstPage + offset, pageSize })
      if (offset === 0) total = page.total

      const remaining = MAX_LOG_ITEMS - items.length
      items.push(...page.items.slice(0, remaining))

      if (page.items.length === 0) break
      if (page.items.length < pageSize) break
      if (page.total > 0 && items.length >= page.total) break
    }

    return { items, total }
  }

  /** Header variants for the pricing page's status request. The first variant
   *  mirrors the website script (browser UA, /pricing referer, credentials),
   *  while the normal API headers remain as a compatibility fallback. */
  siteHeaderVariants(): Array<{ name: string; headers: Record<string, string> }> {
    const browserHeaders: Record<string, string> = {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      Referer: config.botcfBaseUrl + '/pricing'
    }
    if (this.sessionCookie) browserHeaders.Cookie = this.sessionCookie
    if (this.accessToken) browserHeaders.Authorization = `Bearer ${this.accessToken}`
    if (this.userId !== null) browserHeaders['New-Api-User'] = String(this.userId)

    const variants: Array<{ name: string; headers: Record<string, string> }> = [
      { name: 'pricing-browser', headers: browserHeaders }
    ]
    variants.push({ name: 'token', headers: this.headers() })
    return variants
  }

  /** Status fetch across header variants. Rejected envelopes (success:false)
   *  are treated as misses so discovery can move on. */
  async fetchSiteStatus(path: string): Promise<unknown | null> {
    for (const { headers } of this.siteHeaderVariants()) {
      try {
        const res = await botcfFetch(config.botcfBaseUrl + path, { headers })
        if (!res.ok) continue
        const payload = (await res.json()) as { success?: boolean } | null
        if (payload && typeof payload === 'object' && payload.success === false) continue
        return payload
      } catch {
        // Try the next header variant.
      }
    }
    return null
  }

  /** Diagnostic probe: raw HTTP status + body preview per header variant, so a
   *  human can see exactly what the site serves this client at each path. */
  async probeSiteStatus(path: string): Promise<Array<{ variant: string; httpStatus: number | null; payload: unknown | null; preview: string }>> {
    const results: Array<{ variant: string; httpStatus: number | null; payload: unknown | null; preview: string }> = []
    for (const { name, headers } of this.siteHeaderVariants()) {
      try {
        const res = await botcfFetch(config.botcfBaseUrl + path, { headers })
        const text = await res.text()
        let payload: unknown | null = null
        try { payload = JSON.parse(text) } catch { /* HTML challenge page etc. */ }
        results.push({ variant: name, httpStatus: res.status, payload, preview: text.slice(0, 800) })
      } catch (error) {
        results.push({ variant: name, httpStatus: null, payload: null, preview: `请求失败: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    return results
  }

  /** GET /api/user/self/groups — the console's own key-creation group picker
   *  source on New API deployments; user-scoped and the most authoritative
   *  visible-group list. Returns the data payload or null, never throws. */
  async selfGroups(): Promise<unknown | null> {
    try {
      return await this.request<unknown>('GET', '/api/user/self/groups')
    } catch {
      return null
    }
  }

  /** GET /api/pricing — public on many New API deployments; used for group
   *  discovery since /api/group is admin-only on BotCF (verified 401).
   *  Returns the FULL response body: usable_group / group_ratio live at the
   *  top level next to data, so the request() envelope unwrap would drop them.
   *  Never throws — group discovery must degrade gracefully without pricing. */
  async pricing(): Promise<unknown | null> {
    try {
      const res = await botcfFetch(config.botcfBaseUrl + '/api/pricing', { headers: this.headers() })
      if (!res.ok) return null
      const payload = (await res.json()) as { success?: boolean } | null
      if (payload && typeof payload === 'object' && payload.success === false) return null
      return payload
    } catch {
      return null
    }
  }

  /** GET /api/status — public site config. quota_per_unit converts New API
   *  quota units to USD (default 500000 = $1). */
  async siteStatus(): Promise<{ quotaPerUnit: number; turnstileCheck: boolean }> {
    const data = await this.request<Record<string, unknown>>('GET', '/api/status')
    const rawUnit = data.quota_per_unit ?? data.QuotaPerUnit
    const quotaPerUnit = Number(rawUnit)
    return {
      quotaPerUnit: Number.isFinite(quotaPerUnit) && quotaPerUnit > 0 ? quotaPerUnit : 500_000,
      turnstileCheck: Boolean(data.turnstile_check)
    }
  }
}
