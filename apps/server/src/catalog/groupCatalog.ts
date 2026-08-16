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

export interface SelfGroupsCatalog {
  groups: string[]
  descriptions: Record<string, string>
}

/** GET /api/user/self/groups payload: typically a map of group name to
 *  {ratio, desc}; tolerate name->string maps, plain arrays, and junk. */
export function extractSelfGroups(payload: unknown): SelfGroupsCatalog {
  const groups: string[] = []
  const descriptions: Record<string, string> = {}
  if (Array.isArray(payload)) {
    for (const name of payload) {
      if (typeof name === 'string' && name.trim() && !groups.includes(name)) groups.push(name)
    }
    return { groups, descriptions }
  }
  if (!payload || typeof payload !== 'object') return { groups, descriptions }
  for (const [name, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!name.trim() || groups.includes(name)) continue
    groups.push(name)
    if (typeof value === 'string' && value.trim()) {
      descriptions[name] = value
    } else if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>
      const desc = item.desc ?? item.description
      if (typeof desc === 'string' && desc.trim()) descriptions[name] = desc
    }
  }
  return { groups, descriptions }
}

const CATALOG_TTL_MS = 5 * 60_000
let cachedCatalog: PricingCatalog | null = null
let cachedAt = 0

/** TTL-cached site catalog: /api/user/self/groups (the console's own group
 *  picker source) merged with /api/pricing. A failed or empty fetch keeps the
 *  last good snapshot so transient BotCF errors never blank the group list. */
export async function getSiteCatalog(client: BotcfClient, force = false): Promise<PricingCatalog> {
  if (!force && cachedCatalog && Date.now() - cachedAt < CATALOG_TTL_MS) return cachedCatalog
  const [selfRaw, pricingRaw] = await Promise.all([client.selfGroups(), client.pricing()])
  const self = extractSelfGroups(selfRaw)
  const pricing = extractPricingGroups(pricingRaw)
  const combined: PricingCatalog = {
    groups: mergeGroups(self.groups, pricing.groups),
    descriptions: { ...pricing.descriptions, ...self.descriptions },
    modelGroups: pricing.modelGroups
  }
  const hasContent = combined.groups.length > 0 || Object.keys(combined.modelGroups).length > 0
  if (hasContent || cachedCatalog === null) {
    cachedCatalog = combined
    cachedAt = Date.now()
  }
  return cachedCatalog
}

/** Drop the cached catalog (logout / account switch). */
export function resetSiteCatalog(): void {
  cachedCatalog = null
  cachedAt = 0
}

export interface UserGroup {
  name: string
  description?: string
}

/** Default group + key-referenced groups + site-visible groups, deduped. */
export async function listUserGroups(client: BotcfClient, force = false): Promise<UserGroup[]> {
  const [base, catalog] = await Promise.all([discoverGroups(client), getSiteCatalog(client, force)])
  return mergeGroups(base, catalog.groups).map((name) => {
    const description = catalog.descriptions[name]
    return description ? { name, description } : { name }
  })
}
