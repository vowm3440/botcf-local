import { describe, expect, it } from 'vitest'
import { isTrustedLocalRequest } from '../src/secure/localRequest.js'

describe('isTrustedLocalRequest', () => {
  it('accepts loopback and matching same-origin browser requests', () => {
    expect(isTrustedLocalRequest('127.0.0.1:7788', 'http://127.0.0.1:7788')).toBe(true)
    expect(isTrustedLocalRequest('localhost:7788', undefined)).toBe(true)
  })

  it('rejects DNS rebinding hosts and cross-origin browser requests', () => {
    expect(isTrustedLocalRequest('attacker.example', undefined)).toBe(false)
    expect(isTrustedLocalRequest('127.0.0.1:7788', 'https://attacker.example')).toBe(false)
    expect(isTrustedLocalRequest('127.0.0.1:7788', 'http://localhost:7788')).toBe(false)
  })

  it('rejects malformed authorities', () => {
    expect(isTrustedLocalRequest(undefined, undefined)).toBe(false)
    expect(isTrustedLocalRequest('127.0.0.1:7788/path', undefined)).toBe(false)
  })
})
