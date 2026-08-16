import { BotcfClient } from '../botcf/adapter.js'
import { discoverGroups, normalizeGroupName } from '../botcf/keys.js'

/** Comprehensive group discovery. BotCF's /api/group is admin-only, so the
 *  visible group list is merged from three sources: the user's default group,
 *  groups referenced by existing keys, and the public /api/pricing payload
 *  (usable_group + group_ratio + per-model enable_groups). */

export interface PricingCatalog {
  /** Group names in first-seen order, original spelling preserved. */
  groups: string[]
  /** Group name -> human description from usable_group. */
  descriptions: Record<string, string>
  /** Lowercased model id -> normalized lowercase group names serving it. */
  modelGroups: Record<string, string[]>
}

export const emptyPricingCatalog: PricingCatalog = { groups: [], descriptions: {}, modelGroups: {} }

const normalizeGroupKey = (group: string): string => normalizeGroupName(group).toLowerCase()

/** Tolerant extraction: New API deployments differ in which pricing fields
 *  they expose, and field shapes drift across versions. */
export function extractPricingGroups(payload: unknown): PricingCatalog {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return emptyPricingCatalog
  const record = payload as Record<string, unknown>
  const groups: string[] = []
  const descriptions: Record<string, string> = {}
  const modelGroups: Record<string, string[]> = {}
  const seen = new Set<string>()
  const addGroup = (name: unknown): void => {
    if (typeof name !== 'string' || !name.trim() || seen.has(name)) return
    seen.add(name)
    groups.push(name)
  }

  const usable = record.usable_group
  if (Array.isArray(usable)) {
    for (const name of usable) addGroup(name)
  } else if (usable && typeof usable === 'object') {
    for (const [name, description] of Object.entries(usable)) {
      addGroup(name)
      if (typeof description === 'string' && description.trim()) descriptions[name] = description
    }
  }

  const ratio = record.group_ratio
  if (ratio && typeof ratio === 'object' && !Array.isArray(ratio)) {
    for (const name of Object.keys(ratio)) addGroup(name)
  }

  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      if (!item || typeof item !== 'object') continue
      const model = (item as Record<string, unknown>).model_name
      const enabled = (item as Record<string, unknown>).enable_groups
      if (!Array.isArray(enabled)) continue
      const names = enabled.filter((g): g is string => typeof g === 'string' && g.trim() !== '')
      for (const name of names) addGroup(name)
      if (typeof model === 'string' && model.trim() && names.length > 0) {
        modelGroups[model.toLowerCase()] = names.map(normalizeGroupKey)
      }
    }
  }

  return { groups, descriptions, modelGroups }
}

export function mergeGroups(...sources: string[][]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const source of sources) {
    for (const name of source) {
      if (seen.has(name)) continue
      seen.add(name)
      merged.push(name)
    }
  }
  return merged
}

/** True/false when the pricing catalog knows the model's groups; null when it
 *  does not — callers then fall back to the name-family heuristic. */
export function modelAllowedInGroup(modelId: string, group: string, catalog: PricingCatalog): boolean | null {
  const known = catalog.modelGroups[modelId.toLowerCase()]
  if (!known || known.length === 0) return null
  return known.includes(normalizeGroupKey(group))
}

const CATALOG_TTL_MS = 5 * 60_000
let cachedCatalog: PricingCatalog | null = null
let cachedAt = 0

/** TTL-cached pricing catalog; a failed or empty fetch keeps the last good
 *  snapshot so transient BotCF errors never blank the group list. */
export async function getPricingCatalog(client: BotcfClient, force = false): Promise<PricingCatalog> {
  if (!force && cachedCatalog && Date.now() - cachedAt < CATALOG_TTL_MS) return cachedCatalog
  const extracted = extractPricingGroups(await client.pricing())
  const hasContent = extracted.groups.length > 0 || Object.keys(extracted.modelGroups).length > 0
  if (hasContent || cachedCatalog === null) {
    cachedCatalog = extracted
    cachedAt = Date.now()
  }
  return cachedCatalog
}

/** Drop the cached catalog (logout / account switch). */
export function resetPricingCatalog(): void {
  cachedCatalog = null
  cachedAt = 0
}

export interface UserGroup {
  name: string
  description?: string
}

/** Default group + key-referenced groups + pricing-visible groups, deduped. */
export async function listUserGroups(client: BotcfClient, force = false): Promise<UserGroup[]> {
  const [base, catalog] = await Promise.all([discoverGroups(client), getPricingCatalog(client, force)])
  return mergeGroups(base, catalog.groups).map((name) => {
    const description = catalog.descriptions[name]
    return description ? { name, description } : { name }
  })
}
