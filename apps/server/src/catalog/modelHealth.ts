import { getDb } from '../db.js'

/** Route health from the app's own vantage point: the credential proxy records
 *  the outcome of every real upstream request, and this module folds those
 *  probes into an uptime-style cell strip (绿=正常 紫=部分失败 红=全部失败
 *  灰=无请求) plus a window fault rate. */

export type CellState = 'ok' | 'warn' | 'error' | 'idle'

export interface ProbeSample {
  ts: number
  ok: boolean
}

export interface HealthCell {
  start: number
  total: number
  failed: number
  state: CellState
}

export interface ModelHealth {
  cells: HealthCell[]
  total: number
  failed: number
  /** 0..1 across the window; null when there was no traffic at all. */
  faultRate: number | null
  bucketMs: number
  windowMs: number
}

export const HEALTH_BUCKET_MS = 10 * 60_000
export const HEALTH_BUCKET_COUNT = 48 // 48 × 10min = 8 hours

export function cellState(total: number, failed: number): CellState {
  if (total <= 0) return 'idle'
  if (failed <= 0) return 'ok'
  if (failed >= total) return 'error'
  return 'warn'
}

export function buildHealth(
  samples: readonly ProbeSample[],
  now: number,
  bucketMs = HEALTH_BUCKET_MS,
  count = HEALTH_BUCKET_COUNT
): ModelHealth {
  const windowMs = bucketMs * count
  const windowStart = now - windowMs
  const buckets = Array.from({ length: count }, (_, index) => ({
    start: windowStart + index * bucketMs,
    total: 0,
    failed: 0
  }))
  for (const sample of samples) {
    if (sample.ts < windowStart || sample.ts > now) continue
    const index = Math.min(count - 1, Math.floor((sample.ts - windowStart) / bucketMs))
    buckets[index].total++
    if (!sample.ok) buckets[index].failed++
  }
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0)
  const failed = buckets.reduce((sum, bucket) => sum + bucket.failed, 0)
  return {
    cells: buckets.map((bucket) => ({ ...bucket, state: cellState(bucket.total, bucket.failed) })),
    total,
    failed,
    faultRate: total > 0 ? failed / total : null,
    bucketMs,
    windowMs
  }
}

/** Persist one observed upstream outcome; prunes rows older than 2 windows. */
export function recordProbe(group: string, modelId: string, ok: boolean, status: number, now = Date.now()): void {
  const db = getDb()
  db.prepare('INSERT INTO model_probes(ts, group_name, model_id, ok, status) VALUES(?,?,?,?,?)')
    .run(now, group, modelId, ok ? 1 : 0, status)
  db.prepare('DELETE FROM model_probes WHERE ts < ?')
    .run(now - HEALTH_BUCKET_MS * HEALTH_BUCKET_COUNT * 2)
}

export function getModelHealth(group: string, modelId: string, now = Date.now()): ModelHealth {
  const since = now - HEALTH_BUCKET_MS * HEALTH_BUCKET_COUNT
  const rows = getDb()
    .prepare('SELECT ts, ok FROM model_probes WHERE group_name = ? AND model_id = ? AND ts >= ? ORDER BY ts')
    .all(group, modelId, since) as unknown as Array<{ ts: number; ok: number }>
  return buildHealth(rows.map((row) => ({ ts: row.ts, ok: row.ok === 1 })), now)
}
