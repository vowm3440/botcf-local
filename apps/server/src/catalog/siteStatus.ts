import { BotcfClient } from '../botcf/adapter.js'
import { CellState, HealthCell } from './modelHealth.js'

/** BotCF's pricing page loads this exact resource for the model-status bars. */
export const SITE_STATUS_PATH = '/botcf-pricing-group-order-admin?resource=model_status'
const DEFAULT_BUCKET_SECONDS = 60
const DEFAULT_BUCKET_COUNT = 10
const DEFAULT_ERROR_THRESHOLD = 20
const DEFAULT_REFRESH_MS = 15_000
const MIN_REFRESH_MS = 5_000
const MAX_REFRESH_MS = 300_000

export interface SiteHealthCell extends HealthCell {
  /** 0..1 for this minute; null when there was no traffic. */
  errorRate: number | null
}

/** Site-wide model status, normalized with the same display rules used by
 * botcf.com/pricing. */
export interface SiteModelStatus {
  model: string
  requests: number
  errors: number
  successRate: number | null
  /** 0..1 across the site window; null when nobody used the model. */
  errorRate: number | null
  avgTtftSeconds: number | null
  throughputTps: number | null
  /** The per-model threshold after BotCF monitor-rule overrides. */
  displayErrorThreshold: number
  cells: SiteHealthCell[]
}

export interface SiteStatus {
  generatedAt: number
  bucketMs: number
  bucketCount: number
  /** Site's degraded threshold in percent. */
  errorThreshold: number
  refreshMs: number
  group: string
  models: SiteModelStatus[]
}

interface MonitorRule {
  models?: unknown
  force_state?: unknown
  error_threshold?: unknown
  ttft_seconds?: unknown
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

/** Timestamps in the response are unix seconds; tolerate milliseconds too. */
const toMs = (value: number): number => (value > 1e12 ? value : value * 1000)

const normalizeGroupForDisplay = (group: string): string =>
  group.toLowerCase().replace(/[^a-z0-9]+/g, '')

function monitorPatternMatches(value: string, patterns: readonly unknown[]): boolean {
  return patterns.some((pattern) => {
    const escaped = String(pattern ?? '')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    try {
      return new RegExp(`^${escaped}$`, 'i').test(value)
    } catch {
      return false
    }
  })
}

function monitorRuleForModel(model: string, rules: readonly MonitorRule[]): MonitorRule | null {
  return rules.find((rule) => {
    const patterns = Array.isArray(rule.models) ? rule.models : []
    return patterns.length === 0 || monitorPatternMatches(model, patterns)
  }) ?? null
}

function forcedCellState(value: string): CellState | null {
  if (value === 'idle') return 'idle'
  if (value === 'healthy') return 'ok'
  if (value === 'error') return 'warn'
  if (value === 'failed') return 'error'
  return null
}

/** Mirrors botcf-model-status-20260805-v1.js barState(). */
function siteCellState(
  total: number,
  failed: number,
  errorRatePercent: number,
  thresholdPercent: number,
  displayState: string,
  group: string
): CellState {
  if (normalizeGroupForDisplay(group) === 'codexpro') return total > 0 ? 'ok' : 'idle'
  const forced = forcedCellState(displayState)
  if (forced) return forced
  if (total <= 0) return 'idle'
  if (failed >= total) return 'error'
  return errorRatePercent >= thresholdPercent ? 'warn' : 'ok'
}

function paddedBuckets(raw: readonly Record<string, unknown>[], count: number): Record<string, unknown>[] {
  const buckets = raw.slice(-count)
  while (buckets.length < count) buckets.unshift({})
  return buckets
}

export function extractSiteStatus(payload: unknown, requestedGroup = ''): SiteStatus | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data
    : record) as Record<string, unknown>
  if (!Array.isArray(data.models)) return null

  const bucketSeconds = num(data.bucket_seconds) ?? DEFAULT_BUCKET_SECONDS
  const bucketCount = Math.max(1, Math.round(num(data.bucket_count) ?? DEFAULT_BUCKET_COUNT))
  const errorThreshold = num(data.error_threshold) ?? DEFAULT_ERROR_THRESHOLD
  const refreshSeconds = num(data.refresh_seconds) ?? (DEFAULT_REFRESH_MS / 1000)
  const refreshMs = Math.max(MIN_REFRESH_MS, Math.min(MAX_REFRESH_MS, refreshSeconds * 1000))
  const responseGroup = text(data.group)
  const displayGroup = requestedGroup || responseGroup
  const monitorRules = Array.isArray(data.monitor_rules)
    ? data.monitor_rules.filter((rule): rule is MonitorRule => Boolean(rule) && typeof rule === 'object')
    : []

  const models: SiteModelStatus[] = []
  for (const entry of data.models) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const name = text(item.model) || text(item.model_name)
    if (!name) continue

    const requests = num(item.requests) ?? 0
    const errors = num(item.errors) ?? 0
    const rawErrorRate = num(item.error_rate)
    const rawSuccessRate = num(item.success_rate)
    let displayState = text(item.display_state) || 'auto'
    let displayErrorThreshold = num(item.display_error_threshold) ?? errorThreshold
    let displayTtft = num(item.display_avg_ttft_seconds) ?? num(item.avg_ttft_seconds)

    if (!item.monitor_override) {
      const rule = monitorRuleForModel(name, monitorRules)
      if (rule) {
        displayState = text(rule.force_state) || 'auto'
        displayErrorThreshold = num(rule.error_threshold) ?? errorThreshold
        displayTtft = num(rule.ttft_seconds) ?? num(item.avg_ttft_seconds)
      }
    }

    const rawBuckets = Array.isArray(item.buckets)
      ? item.buckets.filter((bucket): bucket is Record<string, unknown> => Boolean(bucket) && typeof bucket === 'object')
      : []
    const cells: SiteHealthCell[] = paddedBuckets(rawBuckets, DEFAULT_BUCKET_COUNT).map((bucket) => {
      const total = num(bucket.requests) ?? 0
      const failed = num(bucket.errors) ?? 0
      const suppliedRate = num(bucket.error_rate)
      const errorRatePercent = suppliedRate ?? (total > 0 ? (failed / total) * 100 : 0)
      return {
        start: toMs(num(bucket.start) ?? 0),
        total,
        failed,
        errorRate: total > 0 ? errorRatePercent / 100 : null,
        state: siteCellState(total, failed, errorRatePercent, displayErrorThreshold, displayState, displayGroup)
      }
    })

    models.push({
      model: name,
      requests,
      errors,
      successRate: rawSuccessRate !== null ? rawSuccessRate / 100 : requests > 0 ? (requests - errors) / requests : null,
      errorRate: rawErrorRate !== null ? rawErrorRate / 100 : requests > 0 ? errors / requests : null,
      avgTtftSeconds: displayTtft,
      throughputTps: num(item.display_throughput_tps) ?? num(item.throughput_tps),
      displayErrorThreshold,
      cells
    })
  }

  const generatedRaw = num(data.generated_at)
  return {
    generatedAt: generatedRaw !== null ? toMs(generatedRaw) : 0,
    bucketMs: bucketSeconds * 1000,
    bucketCount,
    errorThreshold,
    refreshMs,
    group: responseGroup,
    models
  }
}

/** The website renders an all-idle status when a pricing card has no row in
 * the response, rather than hiding the status indicator. */
export function siteModelStatus(status: SiteStatus, model: string): SiteModelStatus {
  return status.models.find((item) => item.model.toLowerCase() === model.toLowerCase()) ?? {
    model,
    requests: 0,
    errors: 0,
    successRate: null,
    errorRate: null,
    avgTtftSeconds: null,
    throughputTps: null,
    displayErrorThreshold: status.errorThreshold,
    cells: Array.from({ length: DEFAULT_BUCKET_COUNT }, () => ({
      start: 0,
      total: 0,
      failed: 0,
      errorRate: null,
      state: 'idle' as const
    }))
  }
}

/** Legacy paths remain diagnostic fallbacks, but the pricing resource above is
 * always tried first and is the normal source. */
const CANDIDATE_PATHS = [
  SITE_STATUS_PATH,
  '/api/models/status',
  '/api/status',
  '/api/model/status',
  '/api/models/dashboard',
  '/api/model_dashboard',
  '/api/status/model',
  '/api/pricing/status'
]

export const SITE_STATUS_CANDIDATE_PATHS: readonly string[] = CANDIDATE_PATHS

interface CacheEntry {
  workingPath: string | null
  status: SiteStatus | null
  cachedAt: number
  lastFailAt: number
}

const caches = new Map<string, CacheEntry>()
let lastCacheKey = ''

function cacheFor(group: string): CacheEntry {
  const key = group.trim().toLowerCase()
  lastCacheKey = key
  const existing = caches.get(key)
  if (existing) return existing
  const created = { workingPath: null, status: null, cachedAt: 0, lastFailAt: 0 }
  caches.set(key, created)
  return created
}

function requestPath(path: string, group: string, now: number): string {
  if (path !== SITE_STATUS_PATH) return path
  const groupQuery = group.trim() ? `&group=${encodeURIComponent(group.trim())}` : ''
  return `${path}${groupQuery}&v=${now}`
}

export function siteStatusDiagnostics(): { workingPath: string | null; cachedAt: number; lastFailAt: number; cachedModels: number | null } {
  const cache = caches.get(lastCacheKey)
  return {
    workingPath: cache?.workingPath ?? null,
    cachedAt: cache?.cachedAt ?? 0,
    lastFailAt: cache?.lastFailAt ?? 0,
    cachedModels: cache?.status ? cache.status.models.length : null
  }
}

export async function getSiteStatus(client: BotcfClient, group = ''): Promise<{ status: SiteStatus | null; path: string | null }> {
  const now = Date.now()
  const cache = cacheFor(group)
  if (cache.status && now - cache.cachedAt < cache.status.refreshMs) {
    return { status: cache.status, path: cache.workingPath }
  }
  if (!cache.status && cache.lastFailAt && now - cache.lastFailAt < DEFAULT_REFRESH_MS) {
    return { status: null, path: null }
  }

  const paths = cache.workingPath
    ? [cache.workingPath, ...CANDIDATE_PATHS.filter((path) => path !== cache.workingPath)]
    : CANDIDATE_PATHS
  for (const path of paths) {
    const raw = await client.fetchSiteStatus(requestPath(path, group, now))
    if (raw === null) continue
    const status = extractSiteStatus(raw, group)
    if (status) {
      cache.workingPath = path
      cache.status = status
      cache.cachedAt = now
      cache.lastFailAt = 0
      return { status, path }
    }
  }
  cache.status = null
  cache.lastFailAt = now
  return { status: null, path: null }
}

/** Drop discovery + cache state (logout / account switch). */
export function resetSiteStatus(): void {
  caches.clear()
  lastCacheKey = ''
}
