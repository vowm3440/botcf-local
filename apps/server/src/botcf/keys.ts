import { BotcfClient, BotcfError, BotcfTokenItem } from './adapter.js'
import { config } from '../config.js'

/** Strip emoji/decorations from a BotCF group name: "⚓codex-plus" -> "codex-plus". */
export function normalizeGroupName(group: string): string {
  return group
    .replace(/[^\p{L}\p{N}\-_.]/gu, '')
    .trim()
}

/** Slug used inside dedicated key names. */
export function groupSlug(group: string): string {
  return normalizeGroupName(group).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 24)
}

export function dedicatedKeyName(group: string): string {
  return `omp-local-${config.deviceId}-${groupSlug(group)}`
}

/** New API keys are presented without the sk- prefix in the console API but the
 *  inference endpoints expect "sk-<key>". */
export function toBearerKey(rawKey: string): string {
  return rawKey.startsWith('sk-') ? rawKey : `sk-${rawKey}`
}

/** Groups a normal user can actually see: their default group plus every group
 *  already referenced by their keys (BotCF's /api/group is admin-only). */
export async function discoverGroups(client: BotcfClient): Promise<string[]> {
  const [user, tokens] = await Promise.all([client.self(), client.listTokens()])
  const groups = new Set<string>()
  if (user.group) groups.add(user.group)
  for (const t of tokens) {
    for (const g of (t.group ?? '').split(',')) {
      const trimmed = g.trim()
      if (trimmed) groups.add(trimmed)
    }
  }
  return [...groups]
}

/** Find-or-create the dedicated key for a group. Never touches user-created
 *  shared keys: we only ever match on our own omp-local-* naming scheme. */
export async function ensureDedicatedKey(client: BotcfClient, group: string): Promise<{ name: string; key: string; token: BotcfTokenItem }> {
  const name = dedicatedKeyName(group)

  const findByName = (tokens: BotcfTokenItem[]): BotcfTokenItem | undefined =>
    tokens.find((t) => t.name === name && t.status === 1)

  let token = findByName(await client.listTokens())
  if (!token) {
    await client.createToken({ name, group, unlimitedQuota: true })
    token = findByName(await client.listTokens())
    if (!token) {
      throw new BotcfError(`创建分组专用 Key 后未能在列表中找到它: ${name}`)
    }
  }
  return { name, key: toBearerKey(token.key), token }
}
