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
    const res = await fetch(config.botcfBaseUrl + path, {
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
  async logs(page = 0, pageSize = 20): Promise<{ items: BotcfLogItem[]; total: number }> {
    const data = await this.request<{ items?: BotcfLogItem[]; total?: number }>(
      'GET',
      `/api/log/self?p=${page}&page_size=${pageSize}&type=0`
    )
    return { items: data.items ?? [], total: data.total ?? 0 }
  }

  /** Raw GET for status-endpoint shape discovery. Callers pass fixed
   *  candidate paths only (never user input); null on any failure. */
  async fetchStatusCandidate(path: string): Promise<unknown | null> {
    try {
      const res = await fetch(config.botcfBaseUrl + path, { headers: this.headers() })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
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
      const res = await fetch(config.botcfBaseUrl + '/api/pricing', { headers: this.headers() })
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
