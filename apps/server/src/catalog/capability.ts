import { getDb } from '../db.js'
import { ApiType } from './routing.js'

export interface CapabilityRow {
  route_key: string
  model_id: string
  group_name: string
  api_type: string
  declared_context: number | null
  verified_context: number | null
  effective_context: number
  max_output: number
  source: string
  confidence: 'verified' | 'documented' | 'inferred'
  last_checked_at: number | null
}

export interface DeclaredSources {
  botcf?: number
  official?: number
  ompCatalog?: number
}

export const FALLBACK_CONTEXT = 128_000
/** Output budget for a model no family rule recognises. Reasoning models spend
 *  this budget on thinking *before* they emit a tool call, so a cap sized for
 *  chat replies (8K) truncates an agent turn mid-thought: the message comes back
 *  with `stopReason: "length"`, no text and no tool call, and the agent loop ends
 *  looking like the assistant simply stopped. */
export const DEFAULT_MAX_OUTPUT = 32_768
/** Never go below the historical cap, however small the window. */
export const MIN_MAX_OUTPUT = 8_192
/** Output may claim at most this share of the window — the rest has to stay
 *  available for the transcript that prompted it. */
export const MAX_OUTPUT_WINDOW_SHARE = 0.25
export const TOOL_CALL_RESERVE = 16_000

export function routeKey(group: string, modelId: string, apiType: ApiType): string {
  return `${group}|${modelId}|${apiType}`
}

/** Resolution rules (pure, unit-tested):
 *  1. an explicit BotCF per-route value WINS outright (plan rule 1);
 *  2. else official model docs;
 *  3. else OMP catalog;
 *  4. conflicting non-BotCF sources -> take the SMALLER until measured;
 *  5. nothing known -> conservative fallback, marked inferred. */
export function resolveDeclared(sources: DeclaredSources): { value: number; source: string; confidence: 'documented' | 'inferred' } {
  if (typeof sources.botcf === 'number') {
    return { value: sources.botcf, source: 'botcf-docs', confidence: 'documented' }
  }
  const candidates = [
    { value: sources.official, source: 'official-docs' },
    { value: sources.ompCatalog, source: 'omp-catalog' }
  ].filter((c): c is { value: number; source: string } => typeof c.value === 'number')

  if (candidates.length === 0) {
    return { value: FALLBACK_CONTEXT, source: 'fallback', confidence: 'inferred' }
  }
  const distinct = new Set(candidates.map((c) => c.value))
  if (distinct.size > 1) {
    const min = candidates.reduce((a, b) => (a.value <= b.value ? a : b))
    return { value: min.value, source: `${min.source} (取多来源较小值)`, confidence: 'inferred' }
  }
  return { value: candidates[0].value, source: candidates[0].source, confidence: candidates[0].source === 'omp-catalog' ? 'inferred' : 'documented' }
}

/** Compaction trigger: usable input is window minus max output minus tool reserve;
 *  trigger at 87.5% of that — never at the raw window size. */
export function compactionThreshold(effectiveContext: number, maxOutput: number = DEFAULT_MAX_OUTPUT): number {
  const usable = Math.max(0, effectiveContext - maxOutput - TOOL_CALL_RESERVE)
  return Math.floor(usable * 0.875)
}

/** Documented BotCF route knowledge (kept tiny on purpose — everything else is
 *  resolved dynamically). gpt-5.6 on Codex routes is documented at 1M. */
export function botcfDocumentedContext(group: string, modelId: string): number | undefined {
  if (/codex/i.test(group) && /^gpt-5\.6/.test(modelId)) return 1_000_000
  return undefined
}

/** Official vendor documentation values by model family. Conservative: only
 *  families with well-known published windows; everything else stays undefined
 *  and falls back as inferred. */
export function officialDocumentedContext(modelId: string): number | undefined {
  const id = modelId.toLowerCase()
  if (id.startsWith('claude')) return 200_000
  if (id.startsWith('gemini')) return 1_000_000
  if (id.startsWith('gpt-4.1')) return 1_000_000
  if (id.startsWith('gpt-4o')) return 128_000
  if (id.startsWith('gpt-5') || id.startsWith('codex')) return 400_000
  if (id.startsWith('grok')) return 256_000
  return undefined
}

/** Published max-output budgets by family, same conservative spirit as
 *  `officialDocumentedContext`. Undefined means "no family rule", which resolves
 *  to `DEFAULT_MAX_OUTPUT`. */
export function officialMaxOutput(modelId: string): number | undefined {
  const id = modelId.toLowerCase()
  if (id.startsWith('gpt-3.5')) return 4_096
  if (id.startsWith('gpt-4o')) return 16_384
  if (id.startsWith('gpt-4')) return 32_768
  if (id.startsWith('gpt-5') || id.startsWith('codex')) return 128_000
  if (/^o[134]/.test(id)) return 100_000
  if (id.startsWith('claude')) return 64_000
  if (id.startsWith('gemini')) return 65_536
  return undefined
}

/** The output cap handed to OMP and to direct requests.
 *
 *  Two bounds meet here. A reasoning model needs enough room to think *and* then
 *  call a tool, so the floor matters; but output is carved out of the same window
 *  as the transcript, so a 128K budget on a 128K model would leave nothing to
 *  prompt with. The window share is the binding constraint on small models, the
 *  documented family value on large ones. */
export function resolveMaxOutput(modelId: string, effectiveContext: number): number {
  const documented = officialMaxOutput(modelId) ?? DEFAULT_MAX_OUTPUT
  const share = Math.max(MIN_MAX_OUTPUT, Math.floor(effectiveContext * MAX_OUTPUT_WINDOW_SHARE))
  return Math.min(documented, share)
}

export function getCapability(key: string): CapabilityRow | null {
  return ((getDb().prepare('SELECT * FROM model_capabilities WHERE route_key = ?').get(key) as unknown as CapabilityRow | undefined) ?? null)
}

export function ensureCapability(group: string, modelId: string, apiType: ApiType): CapabilityRow {
  const key = routeKey(group, modelId, apiType)
  const existing = getCapability(key)
  if (existing) return existing

  const resolved = resolveDeclared({
    botcf: botcfDocumentedContext(group, modelId),
    official: officialDocumentedContext(modelId)
  })
  const row: CapabilityRow = {
    route_key: key,
    model_id: modelId,
    group_name: group,
    api_type: apiType,
    declared_context: resolved.source === 'fallback' ? null : resolved.value,
    verified_context: null,
    effective_context: resolved.value,
    max_output: resolveMaxOutput(modelId, resolved.value),
    source: resolved.source,
    confidence: resolved.confidence,
    last_checked_at: null
  }
  getDb()
    .prepare(`INSERT INTO model_capabilities
      (route_key, model_id, group_name, api_type, declared_context, verified_context, effective_context, max_output, source, confidence, last_checked_at)
      VALUES (@route_key, @model_id, @group_name, @api_type, @declared_context, @verified_context, @effective_context, @max_output, @source, @confidence, @last_checked_at)`)
    .run(row as unknown as Record<string, string | number | null>)
  return row
}

/** A real request succeeded at (or above) this context size: promote to verified. */
export function markVerified(key: string, verifiedContext: number): void {
  getDb()
    .prepare(`UPDATE model_capabilities
      SET verified_context = ?, effective_context = MAX(effective_context, ?), source = 'measured', confidence = 'verified', last_checked_at = ?
      WHERE route_key = ?`)
    .run(verifiedContext, verifiedContext, Date.now(), key)
}

/** Recompute every stored output cap from the current family rules.
 *
 *  `max_output` is derived, never measured, so recomputing it is safe and
 *  idempotent — and necessary: routes created before the cap was family-aware
 *  carry a persisted 8192 that `ensureCapability` would keep returning forever.
 *  Returns how many rows changed. */
export function refreshMaxOutputs(): number {
  const db = getDb()
  const rows = db
    .prepare('SELECT route_key, model_id, effective_context, max_output FROM model_capabilities')
    .all() as unknown as Array<Pick<CapabilityRow, 'route_key' | 'model_id' | 'effective_context' | 'max_output'>>
  const update = db.prepare('UPDATE model_capabilities SET max_output = ? WHERE route_key = ?')
  let changed = 0
  for (const row of rows) {
    const next = resolveMaxOutput(row.model_id, row.effective_context)
    if (next === row.max_output) continue
    update.run(next, row.route_key)
    changed++
  }
  return changed
}

/** Upstream rejected the request for exceeding max context: downgrade the route.
 *  If the error told us the real limit, use it; otherwise back off by 20%.
 *  The output cap rides along, so it never outgrows the shrunken window. */
export function recordContextError(key: string, upstreamLimit?: number): number {
  const row = getCapability(key)
  if (!row) return FALLBACK_CONTEXT
  const next = Math.max(8_000, upstreamLimit ?? Math.floor(row.effective_context * 0.8))
  getDb()
    .prepare(`UPDATE model_capabilities
      SET effective_context = ?, verified_context = ?, max_output = ?, source = 'measured', confidence = 'verified', last_checked_at = ?
      WHERE route_key = ?`)
    .run(next, next, resolveMaxOutput(row.model_id, next), Date.now(), key)
  return next
}

/** UI label per the plan: “1M 原生 · 已验证” / “200K 原生 · 文档确认” / “128K · 推断” */
export function capabilityLabel(row: CapabilityRow): string {
  const size = row.effective_context >= 1_000_000
    ? `${Math.round(row.effective_context / 1_000_000)}M`
    : `${Math.round(row.effective_context / 1_000)}K`
  if (row.confidence === 'verified') return `${size} 原生 · 已验证`
  if (row.confidence === 'documented') return `${size} 原生 · 文档确认`
  return `${size} · 推断,待确认`
}
