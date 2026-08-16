import { FastifyInstance } from 'fastify'
import { appState, applyActiveRouteToOmp, persistBotcfSession, clearBotcfSession, persistRoute } from '../appState.js'
import { BotcfError } from '../botcf/adapter.js'
import { ensureDedicatedKey, discoverGroups } from '../botcf/keys.js'
import { classifyGroup, isSelectableModel, supportedThinkingLevels, modelMatchesGroup } from '../catalog/routing.js'
import { extractPricingGroups, extractSelfGroups, getSiteCatalog, listUserGroups, mergeGroups, modelAllowedInGroup } from '../catalog/groupCatalog.js'
import { getModelHealth } from '../catalog/modelHealth.js'
import { getSiteStatus } from '../catalog/siteStatus.js'
import { ensureCapability, capabilityLabel, compactionThreshold, routeKey } from '../catalog/capability.js'
import { setActiveRoute } from '../proxy/credentialProxy.js'
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

  app.post('/api/auth/logout', async () => {
    clearBotcfSession()
    setActiveRoute(null)
    return { success: true }
  })

  app.get('/api/state', async () => {
    let user = null
    if (appState.botcf.authenticated) {
      user = sanitizeUser(await appState.botcf.self(), await getQuotaPerUnit())
    }
    return {
      success: true,
      authenticated: appState.botcf.authenticated,
      user,
      route: appState.route,
      omp: { available: ompClient.available, running: ompClient.running },
      generationInFlight: appState.generationInFlight
    }
  })

  /** Merged group list (default + key groups + pricing). ?refresh=1 bypasses
   *  the 5-minute pricing cache for the manual sync button. */
  app.get<{ Querystring: { refresh?: string } }>('/api/groups', async (req) => {
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
      appState.botcf.logs(0, 10).catch(() => ({ items: [], total: 0 }))
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

  app.get('/api/logs', async () => ({ success: true, logs: await appState.botcf.logs(0, 20) }))

  /** Uptime-style cells + fault rate for one route: the site's own model
   *  status (as on botcf.com/pricing) when reachable, plus the credential
   *  proxy's local observations. */
  app.get<{ Querystring: { group?: string; model?: string } }>('/api/model-health', async (req, reply) => {
    const group = req.query.group ?? ''
    const model = req.query.model ?? ''
    if (!group || !model) return reply.code(400).send({ success: false, error: '缺少 group 或 model' })
    const { status: site } = await getSiteStatus(appState.botcf)
    const siteModel = site?.models.find((m) => m.model.toLowerCase() === model.toLowerCase()) ?? null
    return {
      success: true,
      health: getModelHealth(group, model),
      site: siteModel,
      siteMeta: site ? { generatedAt: site.generatedAt, bucketMs: site.bucketMs, errorThreshold: site.errorThreshold } : null
    }
  })

  /** Shape discovery for the site's own status source (pending live contract):
   *  probe every plausible New API-family status path in one shot. */
  app.get('/api/model-health/debug', async () => {
    const candidates = ['/api/uptime/status', '/api/status/models', '/api/model_status', '/api/models/status', '/api/monitor/status']
    const probes = await Promise.all(candidates.map(async (path) => {
      const raw = await appState.botcf.fetchStatusCandidate(path)
      return { path, available: raw !== null, preview: raw === null ? null : JSON.stringify(raw).slice(0, 1500) }
    }))
    return { success: true, probes }
  })
}
