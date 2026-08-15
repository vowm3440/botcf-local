import { describe, expect, it } from 'vitest'
import { redact, mask } from '../src/secure/redact.js'

describe('redact', () => {
  it('masks passwords in JSON bodies', () => {
    expect(redact('{"username":"u","password":"hunter2secret"}')).not.toContain('hunter2secret')
  })

  it('masks password in query-style strings', () => {
    expect(redact('password=topsecret123&x=1')).not.toContain('topsecret123')
  })

  it('masks Authorization bearer values', () => {
    const out = redact('Authorization: Bearer sk-abcdef1234567890')
    expect(out).not.toContain('abcdef1234567890')
  })

  it('masks sk- keys anywhere in text', () => {
    const out = redact('upstream error for key sk-verySecretKeyValue123')
    expect(out).not.toContain('verySecretKeyValue123')
    expect(out).toContain('sk-very***')
  })

  it('masks cookies and set-cookie', () => {
    expect(redact('set-cookie: session=abc123def; Path=/')).not.toContain('abc123def')
    expect(redact('cookie: session=abc123def')).not.toContain('abc123def')
  })

  it('masks access_token and session JSON fields', () => {
    const out = redact('{"access_token":"tok123456789","session":"sess987654321"}')
    expect(out).not.toContain('tok123456789')
    expect(out).not.toContain('sess987654321')
  })

  it('mask keeps only edges', () => {
    expect(mask('sk-1234567890abcdef')).toBe('sk-1...cdef')
    expect(mask('short')).toBe('***')
  })
})
