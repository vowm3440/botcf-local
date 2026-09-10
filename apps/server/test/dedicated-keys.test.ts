import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BotcfClient } from '../src/botcf/adapter.js'
import type { BotcfTokenItem } from '../src/botcf/adapter.js'
import { dedicatedKeyName, ensureDedicatedKey } from '../src/botcf/keys.js'

const secrets = vi.hoisted(() => new Map<string, string>())
vi.mock('../src/db.js', () => ({
  getSecret: (name: string) => secrets.get(name) ?? null,
  putSecret: (name: string, value: string) => { secrets.set(name, value) },
  deleteSecret: (name: string) => { secrets.delete(name) }
}))
vi.mock('../src/secure/store.js', () => ({ seal: (value: string) => value, open: (value: string) => value }))

beforeEach(() => { secrets.clear() })

function account(userId: number) {
  const client = new BotcfClient()
  client.restoreState({ sessionCookie: null, accessToken: `test-account-${userId}`, userId })
  let sequence = userId * 100
  let tokens: BotcfTokenItem[] = []
  let issuedKey = ''
  vi.spyOn(client, 'listTokens').mockImplementation(async () => tokens.map((token) => ({ ...token, key: 'masked' })))
  vi.spyOn(client, 'deleteToken').mockImplementation(async (id) => { tokens = tokens.filter((token) => token.id !== id) })
  vi.spyOn(client, 'createToken').mockImplementation(async ({ name, group }) => {
    const id = ++sequence
    issuedKey = `sk-account${userId}-token${id}-abcdefghijklmnop`
    const token = { id, name, group, key: issuedKey, status: 1 } as BotcfTokenItem
    tokens.push(token)
    return token
  })
  return {
    client,
    key: () => issuedKey,
    replaceToken: () => {
      tokens = [{ id: ++sequence, name: dedicatedKeyName('codex'), group: 'codex', key: 'masked', status: 1 } as BotcfTokenItem]
    }
  }
}

describe('dedicated inference credential ownership', () => {
  it('never returns the previous account key for an identically named token', async () => {
    const first = account(1)
    const second = account(2)
    const firstRoute = await ensureDedicatedKey(first.client, 'codex')
    second.replaceToken()
    const secondRoute = await ensureDedicatedKey(second.client, 'codex')
    expect(secondRoute.key).toBe(second.key())
    expect(secondRoute.key).not.toBe(firstRoute.key)
    expect((await ensureDedicatedKey(first.client, 'codex')).key).toBe(firstRoute.key)
  })

  it('does not reuse a cached key after its remote token was replaced under the same name', async () => {
    const user = account(1)
    const previous = await ensureDedicatedKey(user.client, 'codex')
    user.replaceToken()
    const next = await ensureDedicatedKey(user.client, 'codex')
    expect(next.key).toBe(user.key())
    expect(next.key).not.toBe(previous.key)
    expect((await ensureDedicatedKey(user.client, 'codex')).key).toBe(next.key)
  })
})
