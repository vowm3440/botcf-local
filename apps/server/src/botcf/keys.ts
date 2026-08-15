import { BotcfClient, BotcfError, BotcfTokenItem } from './adapter.js'
import { config } from '../config.js'
import { deleteSecret, getSecret, putSecret } from '../db.js'
import { open, seal } from '../secure/store.js'

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


function isUsableBearerKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(value)
}
/** Find-or-create the dedicated key for a group. Never touches user-created
 *  shared keys: we only ever match on our own omp-local-* naming scheme. */
export async function ensureDedicatedKey(client: BotcfClient, group: string): Promise<{ name: string; key: string; token: BotcfTokenItem }> {
  const name = dedicatedKeyName(group)
  const secretName = `botcf.dedicated-key.${name}`
  const findByName = (tokens: BotcfTokenItem[]): BotcfTokenItem | undefined =>
    tokens.find((item) => item.name === name && item.status === 1)

  let cachedKey: string | null = null
  const encrypted = getSecret(secretName)
  if (encrypted) {
    try {
      const opened = open(encrypted)
      if (isUsableBearerKey(opened)) cachedKey = opened
      else deleteSecret(secretName)
    } catch {
      deleteSecret(secretName)
    }
  }

  let token = findByName(await client.listTokens())
  if (token && cachedKey) return { name, key: cachedKey, token }

  // Older builds did not persist generated keys. Rotate only our namespaced key
  // once, because New API installations may mask it on subsequent list calls.
  if (token) {
    await client.deleteToken(token.id)
    token = undefined
  }
  const created = await client.createToken({ name, group, unlimitedQuota: true })
  token = created ?? findByName(await client.listTokens())
  if (!token) {
    throw new BotcfError(`创建分组专用 Key 后未能在列表中找到它: ${name}`)
  }
  if (!isUsableBearerKey(toBearerKey(token.key))) {
    token = { ...token, key: await client.revealTokenKey(token.id) }
  }
  const key = toBearerKey(token.key)
  if (!isUsableBearerKey(key)) {
    throw new BotcfError(`BotCF 未返回可用的完整 Key: ${name}`)
  }
  putSecret(secretName, seal(key))
  return { name, key, token }
}
