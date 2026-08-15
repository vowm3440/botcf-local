import { describe, expect, it } from 'vitest'
import { isProxyRequestAuthorized, requestedModel } from '../src/proxy/credentialProxy.js'

describe('credential proxy authorization', () => {
  it('accepts the per-process bearer or x-api-key capability', () => {
    expect(isProxyRequestAuthorized('Bearer secret', undefined, 'secret')).toBe(true)
    expect(isProxyRequestAuthorized(undefined, 'secret', 'secret')).toBe(true)
  })

  it('rejects public placeholders and malformed bodies', () => {
    expect(isProxyRequestAuthorized('Bearer proxy-managed', undefined, 'secret')).toBe(false)
    expect(requestedModel({ model: 'gpt-5.4' })).toBe('gpt-5.4')
    expect(requestedModel([])).toBeUndefined()
  })
})
