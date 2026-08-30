import { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import { appState, applyActiveRouteToOmp, persistBotcfSession, clearBotcfSession, persistRoute, isAuthenticated, setThirdParty, getThirdPartyKey } from '../appState.js'
import { BotcfError, BotcfLogItem, LogQuery } from '../botcf/adapter.js'
import { ensureDedicatedKey, discoverGroups } from '../botcf/keys.js'
import { classifyGroup, isSelectableModel, supportedThinkingLevels, modelMatchesGroup, normalizeBaseUrl, parseModelList, thirdPartyApiType, THIRD_PARTY_GROUP, THIRD_PARTY_THINKING_LEVELS } from '../catalog/routing.js'
import { extractPricingGroups, extractSelfGroups, getSiteCatalog, listUserGroups, mergeGroups, modelAllowedInGroup } from '../catalog/groupCatalog.js'
import { getModelHealth } from '../catalog/modelHealth.js'
import { getSiteStatus, extractSiteStatus, siteModelStatus, siteStatusDiagnostics, SITE_STATUS_CANDIDATE_PATHS } from '../catalog/siteStatus.js'
import { ensureCapability, capabilityLabel, compactionThreshold, routeKey } from '../catalog/capability.js'
import { setActiveRoute } from '../proxy/credentialProxy.js'
import { getAccessMode } from '../omp/access.js'
import { ompClient } from '../omp/rpc.js'
import { getDb } from '../db.js'
import { redact } from '../secure/redact.js'

/** quota units -> USD conversion factor, refreshed lazily from /api/status. */
let quotaPerUnit = 500_000
let quotaPerUnitFetchedAt = 0

async function getQuotaPerUnit(): Promise<number> {
  if (Date.now() - quotaPerUnitFetchedAt > 10 * 60_000) {
    try {
      const s = await appState.botcf.siteStatus()
      quotaPerUnit = s.quotaPerUnit
      quotaPerUnitFetchedAt = Date.now()
    } catch {
      /* keep the last known factor */
    }
  }
  return quotaPerUnit
}

function sanitizeUser(u: { id: number; username: string; display_name: string; group: string; quota: number; used_quota: number; request_count: number }, qpu: number) {
  return {
    username: u.username,
    displayName: u.display_name,
    defaultGroup: u.group,
    quota: u.quota,
    usedQuota: u.used_quota,
    quotaUsd: u.quota / qpu,
    usedQuotaUsd: u.used_quota / qpu,
    requestCount: u.request_count
  }
}

interface LogsQuerystring {
  page?: string
  pageSize?: string
  page_size?: string
  p?: string
  tokenName?: string
  token_name?: string
  modelName?: string
  model_name?: string
  group?: string
  startTs?: string
  start_timestamp?: string
  endTs?: string
  end_timestamp?: string
  format?: string
}

interface LogResponseItem extends BotcfLogItem {
  quotaUsd: number
}

const LOG_FETCH_PAGE_SIZE = 100
const LOG_FETCH_MAX_PAGES = 100

function badRequest(message: string): never {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = 400
  throw error
}

function queryValue(query: LogsQuerystring, camel: keyof LogsQuerystring, snake: keyof LogsQuerystring): string | undefined {
  const value = query[camel] ?? query[snake]
  return typeof value === 'string' ? value : undefined
}

function parseInteger(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    badRequest(`${name} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return parsed
}

function parseTimestamp(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) badRequest(`${name} 必须是非负数字时间戳`)
  return parsed
}

function parseLogsQuery(query: LogsQuerystring): LogQuery {
  const parsed: LogQuery = {
    page: parseInteger(queryValue(query, 'page', 'p'), 'page', 0, 0, 1_000_000),
    pageSize: parseInteger(queryValue(query, 'pageSize', 'page_size'), 'pageSize', 20, 1, 100)
  }
  const tokenName = queryValue(query, 'tokenName', 'token_name')?.trim()
  const modelName = queryValue(query, 'modelName', 'model_name')?.trim()
  const group = query.group?.trim()
  if (tokenName) parsed.tokenName = tokenName
  if (modelName) parsed.modelName = modelName
  if (group) parsed.group = group
  parsed.startTs = parseTimestamp(queryValue(query, 'startTs', 'start_timestamp'), 'startTs')
  parsed.endTs = parseTimestamp(queryValue(query, 'endTs', 'end_timestamp'), 'endTs')
  if (parsed.startTs !== undefined && parsed.endTs !== undefined && parsed.startTs > parsed.endTs) {
    badRequest('startTs 不能晚于 endTs')
  }
  return parsed
}

function includesFolded(value: string, search: string | undefined): boolean {
  return !search || value.toLocaleLowerCase().includes(search.toLocaleLowerCase())
}

function filterLogs(items: BotcfLogItem[], query: LogQuery): BotcfLogItem[] {
  return items.filter((item) => (
    item.type === 2
    && includesFolded(item.token_name ?? '', query.tokenName)
    && includesFolded(item.model_name ?? '', query.modelName)
    && (!query.group || (item.group ?? '').toLocaleLowerCase() === query.group.toLocaleLowerCase())
    && (query.startTs === undefined || item.created_at >= query.startTs)
    && (query.endTs === undefined || item.created_at <= query.endTs)
  ))
}

async function loadFilteredLogs(query: LogQuery): Promise<BotcfLogItem[]> {
  // Strategy B: upstream filtering is unverified, so fetch bounded raw pages
  // and apply every filter locally for deterministic behavior.
  const result = await appState.botcf.fetchAllLogs({ page: 0, pageSize: LOG_FETCH_PAGE_SIZE }, LOG_FETCH_MAX_PAGES)
  return filterLogs(result.items, query)
}

function responseItem(item: BotcfLogItem, quotaUnit: number): LogResponseItem {
  return { ...item, quotaUsd: item.quota / quotaUnit }
}

function csvField(value: string | number | boolean): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvRow(item: BotcfLogItem, quotaUnit: number): string {
  return [
    new Date(item.created_at * 1000).toISOString(),
    item.group,
    item.token_name,
    item.model_name,
    item.prompt_tokens,
    item.completion_tokens,
    item.quota,
    item.quota / quotaUnit,
    item.use_time,
    item.is_stream
  ].map(csvField).join(',') + '\r\n'
}

function exportRange(query: LogQuery): string {
  const date = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(0, 10)
  if (query.startTs !== undefined && query.endTs !== undefined) return `${date(query.startTs)}-to-${date(query.endTs)}`
  if (query.startTs !== undefined) return `from-${date(query.startTs)}`
  if (query.endTs !== undefined) return `to-${date(query.endTs)}`
  return 'all'
}

function csvStream(items: BotcfLogItem[], quotaUnit: number): Readable {
  function* chunks() {
    yield '\ufeff'
    yield '时间,分组,令牌,模型,prompt_tokens,completion_tokens,quota,折算 USD,耗时(秒),是否流式\r\n'
    for (const item of items) yield csvRow(item, quotaUnit)
  }
  return Readable.from(chunks())
}

function jsonStream(items: LogResponseItem[]): Readable {
  function* chunks() {
    yield '[\n'
    for (let index = 0; index < items.length; index++) {
      yield `${index === 0 ? '' : ',\n'}${JSON.stringify(items[index])}`
    }
    yield '\n]\n'
  }
  return Readable.from(chunks())
}

export function registerApiRoutes(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err instanceof Error ? err : new Error(String(err))
    req.log.error(redact(e.message))
    const status = err instanceof BotcfError ? 502 : ((e as { statusCode?: number }).statusCode ?? 500)
    reply.code(status).send({ success: false, error: redact(e.message) })
  })

  app.post<{ Body: { mode: 'password' | 'token'; username?: string; password?: string; token?: string } }>(
    '/api/auth/login',
    async (req, reply) => {
      const { mode, username, password, token } = req.body ?? ({} as never)
      if (mode === 'password') {
        if (!username || !password) return reply.code(400).send({ success: false, error: '缺少用户名或密码' })
        const user = await appState.botcf.loginWithPassword(username, password)
        persistBotcfSession()
        const qpu = await getQuotaPerUnit()
        return { success: true, user: sanitizeUser(await appState.botcf.self().catch(() => user), qpu) }
      }
      if (mode === 'token') {
        if (!token) return reply.code(400).send({ success: false, error: '缺少管理 Token' })
        const user = await appState.botcf.loginWithAccessToken(token.trim())
        persistBotcfSession()
        return { success: true, user: sanitizeUser(user, await getQuotaPerUnit()) }
      }
      return reply.code(400).send({ success: false, error: 'mode 必须是 password 或 token' })
    }
  )

  /** Third-party custom provider: user-supplied endpoint, key and models.
   *  The key is sealed immediately and never returned to the frontend. */
  app.post<{ Body: { baseUrl?: string; apiKey?: string; models?: string } }>(
    '/api/auth/third-party',
    async (req, reply) => {
      const baseUrl = normalizeBaseUrl(req.body?.baseUrl ?? '')
      const apiKey = (req.body?.apiKey ?? '').trim()
      const models = parseModelList(req.body?.models ?? '')
      if (!baseUrl) return reply.code(400).send({ success: false, error: 'Base URL 无效:需以 http(s):// 开头,不带 /v1' })
      if (!apiKey) return reply.code(400).send({ success: false, error: '缺少 API Key' })
      if (models.length === 0) return reply.code(400).send({ success: false, error: '至少填写一个模型 ID' })
      setThirdParty({ baseUrl, apiKey, models })
      return { success: true, thirdParty: { baseUrl, models } }
    }
  )

  app.post('/api/auth/logout', async () => {
    clearBotcfSession()
    setActiveRoute(null)
    return { success: true }
  })

  app.get('/api/state', async () => {
    let user = null
    if (appState.botcf.authenticated) {
      // Local control-plane state must stay available when BotCF is briefly
      // unreachable. Account details can refresh later through /api/usage.
      const upstreamUser = await appState.botcf.self().catch(() => null)
      if (upstreamUser) user = sanitizeUser(upstreamUser, await getQuotaPerUnit())
    }
    return {
      success: true,
      authenticated: isAuthenticated(),
      mode: appState.thirdParty ? 'third-party' : 'botcf',
      thirdParty: appState.thirdParty,
      user,
      route: appState.route,
      // Startup restoration may still be in flight; see appState.restoring.
      restoring: appState.restoring,
      omp: { available: ompClient.available, running: ompClient.running, accessMode: getAccessMode() },
      generationInFlight: appState.generationInFlight
    }
  })

  /** Merged group list (default + key groups + pricing). ?refresh=1 bypasses
   *  the 5-minute pricing cache for the manual sync button. */
  app.get<{ Querystring: { refresh?: string } }>('/api/groups', async (req) => {
    if (appState.thirdParty) {
      return {
        success: true,
        groups: [{ name: THIRD_PARTY_GROUP, description: appState.thirdParty.baseUrl, apiType: 'chat', usable: true, hidden: false }]
      }
    }
    const groups = await listUserGroups(appState.botcf, req.query.refresh === '1')
    return {
      success: true,
      groups: groups.map(({ name, description }) => {
        const policy = classifyGroup(name)
        return { name, ...(description ? { description } : {}), ...policy }
      })
    }
  })

  /** Diagnostics: what each discovery source actually returned, so shape
   *  drift on BotCF's side is visible instead of silently shrinking the list. */
  app.get('/api/groups/debug', async () => {
    const describeShape = (value: unknown): string => {
      if (value === null) return 'null(接口不可用或返回失败)'
      if (Array.isArray(value)) return `array(${value.length})`
      if (typeof value === 'object') return `object keys: ${Object.keys(value as object).slice(0, 15).join(', ')}`
      return typeof value
    }
    const base = await discoverGroups(appState.botcf)
    const [selfRaw, pricingRaw] = await Promise.all([appState.botcf.selfGroups(), appState.botcf.pricing()])
    const self = extractSelfGroups(selfRaw)
    const pricing = extractPricingGroups(pricingRaw)
    return {
      success: true,
      base,
      selfGroups: { shape: describeShape(selfRaw), groups: self.groups },
      pricing: { shape: describeShape(pricingRaw), groups: pricing.groups, modelsWithGroups: Object.keys(pricing.modelGroups).length },
      merged: mergeGroups(base, self.groups, pricing.groups).map((name) => ({ name, ...classifyGroup(name) }))
    }
  })

  app.get<{ Querystring: { group?: string } }>('/api/models', async (req) => {
    const group = req.query.group ?? ''
    if (appState.thirdParty && group === THIRD_PARTY_GROUP) {
      return {
        success: true,
        models: appState.thirdParty.models.map((id) => {
          const apiType = thirdPartyApiType(id)
          const cap = ensureCapability(THIRD_PARTY_GROUP, id, apiType)
          return {
            id,
            apiType,
            thinkingLevels: THIRD_PARTY_THINKING_LEVELS,
            contextLabel: capabilityLabel(cap),
            effectiveContext: cap.effective_context,
            confidence: cap.confidence
          }
        })
      }
    }
    const policy = classifyGroup(group)
    const [all, catalog] = await Promise.all([appState.botcf.models(), getSiteCatalog(appState.botcf)])
    const models = all
      .filter(isSelectableModel)
      // Real per-model group data from pricing wins; the name-family heuristic
      // only decides models the catalog has never heard of.
      .filter((id) => modelAllowedInGroup(id, group, catalog) ?? modelMatchesGroup(group, id))
      .map((id) => {
      const cap = ensureCapability(group, id, policy.apiType)
      return {
        id,
        apiType: policy.apiType,
        thinkingLevels: supportedThinkingLevels(policy.apiType, id),
        contextLabel: capabilityLabel(cap),
        effectiveContext: cap.effective_context,
        confidence: cap.confidence
      }
    })
    return { success: true, models }
  })

  app.post<{ Body: { group: string; model: string; thinkingLevel?: string } }>('/api/route', async (req, reply) => {
    const { group, model, thinkingLevel } = req.body ?? ({} as never)
    if (!group || !model) return reply.code(400).send({ success: false, error: '缺少 group 或 model' })

    if (group === THIRD_PARTY_GROUP) {
      if (!appState.thirdParty) return reply.code(409).send({ success: false, error: '未配置第三方提供商' })
      if (!appState.thirdParty.models.includes(model)) {
        return reply.code(400).send({ success: false, error: '模型不在第三方模型列表中' })
      }
      const bearer = getThirdPartyKey()
      if (!bearer) return reply.code(409).send({ success: false, error: '第三方凭据缺失,请退出后重新配置' })
      const apiType = thirdPartyApiType(model)
      const level = thinkingLevel && THIRD_PARTY_THINKING_LEVELS.includes(thinkingLevel) ? thinkingLevel : 'medium'
      const cap = ensureCapability(group, model, apiType)
      const rk = routeKey(group, model, apiType)

      setActiveRoute({ routeKey: rk, apiType, bearerKey: bearer, modelId: model, group, baseUrl: appState.thirdParty.baseUrl })
      appState.route = {
        group,
        modelId: model,
        apiType,
        thinkingLevel: level,
        routeKey: rk,
        tokenName: '第三方 Key',
        capabilityLabel: capabilityLabel(cap),
        effectiveContext: cap.effective_context
      }
      getDb()
        .prepare('INSERT INTO session_routes(session_id, changed_at, group_name, model_id, api_type, token_name) VALUES(?,?,?,?,?,?)')
        .run('default', Date.now(), group, model, apiType, '第三方 Key')
      persistRoute()

      let ompApplied = false
      if (ompClient.running) {
        try {
          ompApplied = await applyActiveRouteToOmp()
        } catch (err: unknown) {
          req.log.warn(`OMP set_model 失败,降级直连: ${err instanceof Error ? err.message : String(err)}`)
          await ompClient.stop()
        }
      }
      return {
        success: true,
        route: appState.route,
        ompApplied,
        compactionThreshold: compactionThreshold(cap.effective_context, cap.max_output)
      }
    }

    if (!appState.botcf.authenticated) {
      return reply.code(401).send({ success: false, error: '未登录 BotCF' })
    }

    const policy = classifyGroup(group)
    if (!policy.usable) {
      return reply.code(409).send({ success: false, error: policy.reason ?? '该分组不可用于 OMP' })
    }
    const levels = supportedThinkingLevels(policy.apiType, model)
    const level = thinkingLevel && levels.includes(thinkingLevel) ? thinkingLevel : levels[Math.min(1, Math.max(levels.length - 1, 0))] ?? null

    // Atomic switch: group -> dedicated key -> api type -> capability -> proxy -> OMP.
    const dedicated = await ensureDedicatedKey(appState.botcf, group)
    const cap = ensureCapability(group, model, policy.apiType)
    const key = routeKey(group, model, policy.apiType)

    setActiveRoute({
      routeKey: key,
      apiType: policy.apiType,
      bearerKey: dedicated.key,
      modelId: model,
      group
    })

    appState.route = {
      group,
      modelId: model,
      apiType: policy.apiType,
      thinkingLevel: level,
      routeKey: key,
      tokenName: dedicated.name,
      capabilityLabel: capabilityLabel(cap),
      effectiveContext: cap.effective_context
    }

    getDb()
      .prepare('INSERT INTO session_routes(session_id, changed_at, group_name, model_id, api_type, token_name) VALUES(?,?,?,?,?,?)')
      .run('default', Date.now(), group, model, policy.apiType, dedicated.name)

    persistRoute()

    let ompApplied = false
    if (ompClient.running) {
      try {
        ompApplied = await applyActiveRouteToOmp()
      } catch (err: unknown) {
        // OMP misbehaving must not break routing — the credential proxy is
        // already armed, so chat falls back to direct mode.
        req.log.warn(`OMP set_model 失败,降级直连: ${err instanceof Error ? err.message : String(err)}`)
        await ompClient.stop()
      }
    }

    return {
      success: true,
      route: appState.route,
      ompApplied,
      compactionThreshold: compactionThreshold(cap.effective_context, cap.max_output)
    }
  })

  app.get('/api/usage', async () => {
    const [user, stat, qpu, logs] = await Promise.all([
      appState.botcf.self(),
      appState.botcf.usageStat(),
      getQuotaPerUnit(),
      appState.botcf.logs({ page: 0, pageSize: 10 }).catch(() => ({ items: [], total: 0 }))
    ])
    const recentRequests = logs.items
      .filter((i) => i.type === 2)
      .slice(0, 5)
      .map((i) => ({
        model: i.model_name,
        group: i.group,
        promptTokens: i.prompt_tokens,
        completionTokens: i.completion_tokens,
        costUsd: i.quota / qpu,
        useTimeSeconds: i.use_time,
        at: i.created_at * 1000
      }))
    return {
      success: true,
      account: {
        quota: user.quota,
        usedQuota: user.used_quota,
        quotaUsd: user.quota / qpu,
        usedQuotaUsd: user.used_quota / qpu,
        requestCount: user.request_count
      },
      stat,
      recentRequests,
      quotaPerUnit: qpu,
      refreshedAt: Date.now()
    }
  })

  app.get<{ Querystring: LogsQuerystring }>('/api/logs', async (req) => {
    const query = parseLogsQuery(req.query)
    const [filtered, quotaUnit] = await Promise.all([loadFilteredLogs(query), getQuotaPerUnit()])
    const start = query.page * query.pageSize
    return {
      success: true,
      items: filtered.slice(start, start + query.pageSize).map((item) => responseItem(item, quotaUnit)),
      total: filtered.length,
      page: query.page,
      pageSize: query.pageSize
    }
  })

  app.get<{ Querystring: LogsQuerystring }>('/api/logs/export', async (req, reply) => {
    const query = parseLogsQuery(req.query)
    const format = (req.query.format ?? '').toLocaleLowerCase()
    if (format !== 'csv' && format !== 'json') badRequest('format 必须是 csv 或 json')

    const [items, quotaUnit] = await Promise.all([loadFilteredLogs(query), getQuotaPerUnit()])
    const range = exportRange(query)
    reply.header('Content-Disposition', `attachment; filename="botcf-logs-${range}.${format}"`)

    if (format === 'csv') {
      reply.type('text/csv; charset=utf-8')
      return reply.send(csvStream(items, quotaUnit))
    }

    reply.type('application/json; charset=utf-8')
    return reply.send(jsonStream(items.map((item) => responseItem(item, quotaUnit))))
  })

  /** Uptime-style cells + fault rate for one route: the site's own model
   *  status (as on botcf.com/pricing) when reachable, plus the credential
   *  proxy's local observations. */
  app.get<{ Querystring: { group?: string; model?: string } }>('/api/model-health', async (req, reply) => {
    const group = req.query.group ?? ''
    const model = req.query.model ?? ''
    if (!group || !model) return reply.code(400).send({ success: false, error: '缺少 group 或 model' })
    const { status: site } = await getSiteStatus(appState.botcf, group)
    const siteModel = site ? siteModelStatus(site, model) : null
    return {
      success: true,
      health: getModelHealth(group, model),
      site: siteModel,
      siteMeta: site ? {
        generatedAt: site.generatedAt,
        bucketMs: site.bucketMs,
        bucketCount: site.bucketCount,
        errorThreshold: site.errorThreshold,
        refreshMs: site.refreshMs,
        group: site.group
      } : null
    }
  })

  /** Site-status diagnostics: probe every candidate path with every auth
   *  variant, run the extractor on each payload, and expose discovery state.
   *  Open http://127.0.0.1:7788/api/model-health/debug in a browser; append
   *  ?path=/api/xxx to probe one extra path (e.g. one found in DevTools). */
  app.get<{ Querystring: { path?: string } }>('/api/model-health/debug', async (req, reply) => {
    const extra = (req.query.path ?? '').trim()
    if (extra && (!/^\/(?:api\/[A-Za-z0-9/_.?&=-]*|botcf-pricing-group-order-admin\?[A-Za-z0-9_?&=%.-]*)$/.test(extra) || extra.includes('..'))) {
      return reply.code(400).send({ success: false, error: 'path 必须是允许的 BotCF 站内状态路径' })
    }
    const paths = extra ? [extra, ...SITE_STATUS_CANDIDATE_PATHS.filter((p) => p !== extra)] : [...SITE_STATUS_CANDIDATE_PATHS]
    const probes = await Promise.all(paths.map(async (path) => {
      const variants = await appState.botcf.probeSiteStatus(path)
      return {
        path,
        variants: variants.map(({ variant, httpStatus, payload, preview }) => {
          const extracted = payload === null ? null : extractSiteStatus(payload)
          return {
            variant,
            httpStatus,
            isJson: payload !== null,
            extractedModels: extracted ? extracted.models.length : 0,
            preview
          }
        })
      }
    }))
    return { success: true, discovery: siteStatusDiagnostics(), probes }
  })
}
