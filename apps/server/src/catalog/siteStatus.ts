import { BotcfClient } from '../botcf/adapter.js'
import { HealthCell, cellState } from './modelHealth.js'

/** Site-wide model status, as shown on botcf.com/pricing: per-model request /
 *  error totals plus 60-second buckets. Shape captured live 2026-08-16
 *  (docs/botcf-api-contract.md #6); the serving path is auto-discovered from a
 *  candidate list because the page's exact endpoint is not documented. */

export interface SiteModelStatus {
  model: string
  requests: number
  errors: number
  /** 0..1 across the site window; null when nobody used the model. */
  errorRate: number | null
  avgTtftSeconds: number | null
  throughputTps: number | null
  cells: HealthCell[]
}

export interface SiteStatus {
  generatedAt: number
  bucketMs: number
  /** Site's own degraded-threshold in percent, when provided. */
  errorThreshold: number | null
  models: SiteModelStatus[]
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Timestamps in the capture are unix seconds; tolerate milliseconds too. */
const toMs = (value: number): number => (value > 1e12 ? value : value * 1000)

export function extractSiteStatus(payload: unknown): SiteStatus | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data
    : record) as Record<string, unknown>
  if (!Array.isArray(data.models)) return null

  const models: SiteModelStatus[] = []
  for (const entry of data.models) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const name = typeof item.model === 'string' && item.model.trim()
      ? item.model
      : typeof item.model_name === 'string' && item.model_name.trim()
        ? item.model_name
        : null
    if (!name) continue
    const requests = num(item.requests) ?? 0
    const errors = num(item.errors) ?? 0
    const ratePercent = num(item.error_rate)
    const cells: HealthCell[] = Array.isArray(item.buckets)
      ? item.buckets
          .filter((bucket): bucket is Record<string, unknown> => Boolean(bucket) && typeof bucket === 'object')
          .map((bucket) => {
            const total = num(bucket.requests) ?? 0
            const failed = num(bucket.errors) ?? 0
            return { start: toMs(num(bucket.start) ?? 0), total, failed, state: cellState(total, failed) }
          })
      : []
    models.push({
      model: name,
      requests,
      errors,
      errorRate: ratePercent !== null ? ratePercent / 100 : requests > 0 ? errors / requests : null,
      avgTtftSeconds: num(item.avg_ttft_seconds),
      throughputTps: num(item.throughput_tps),
      cells
    })
  }
  if (models.length === 0 && data.models.length > 0) return { generatedAt: 0, bucketMs: 60_000, errorThreshold: null, models: [] }

  const generatedRaw = num(data.generated_at)
  return {
    generatedAt: generatedRaw !== null ? toMs(generatedRaw) : 0,
    bucketMs: (num(data.bucket_seconds) ?? 60) * 1000,
    errorThreshold: num(data.error_threshold),
    models
  }
}

/** Paths the pricing page's status data plausibly lives at. The known-existing
 *  '/api/models/status' goes first — it rejected token auth ("权限不足") but the
 *  browser succeeds with the session cookie, so fetchSiteStatus retries with a
 *  cookie-first header variant. */
const CANDIDATE_PATHS = [
  '/api/models/status',
  '/api/model/status',
  '/api/models/dashboard',
  '/api/model_dashboard',
  '/api/status/model',
  '/api/pricing/status'
]

const SITE_TTL_MS = 30_000
const FAIL_TTL_MS = 5 * 60_000
let workingPath: string | null = null
let cachedStatus: SiteStatus | null = null
let cachedAt = 0
let lastFailAt = 0

export async function getSiteStatus(client: BotcfClient): Promise<{ status: SiteStatus | null; path: string | null }> {
  const now = Date.now()
  if (cachedStatus && now - cachedAt < SITE_TTL_MS) return { status: cachedStatus, path: workingPath }
  if (!cachedStatus && lastFailAt && now - lastFailAt < FAIL_TTL_MS) return { status: null, path: null }

  const paths = workingPath
    ? [workingPath, ...CANDIDATE_PATHS.filter((path) => path !== workingPath)]
    : CANDIDATE_PATHS
  for (const path of paths) {
    const raw = await client.fetchSiteStatus(path)
    if (raw === null) continue
    const status = extractSiteStatus(raw)
    if (status && status.models.length > 0) {
      workingPath = path
      cachedStatus = status
      cachedAt = now
      lastFailAt = 0
      return { status, path }
    }
  }
  cachedStatus = null
  lastFailAt = now
  return { status: null, path: null }
}

/** Drop discovery + cache state (logout / account switch). */
export function resetSiteStatus(): void {
  workingPath = null
  cachedStatus = null
  cachedAt = 0
  lastFailAt = 0
}
