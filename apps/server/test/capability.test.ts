import { describe, expect, it } from 'vitest'
import { resolveDeclared, compactionThreshold, botcfDocumentedContext, officialDocumentedContext, FALLBACK_CONTEXT } from '../src/catalog/capability.js'

describe('resolveDeclared', () => {
  it('an explicit BotCF route value wins outright (plan rule 1)', () => {
    const r = resolveDeclared({ botcf: 1_000_000, official: 400_000 })
    expect(r.value).toBe(1_000_000)
    expect(r.confidence).toBe('documented')
    expect(r.source).toBe('botcf-docs')
  })

  it('conflicting non-BotCF sources take the smaller value until measured', () => {
    const r = resolveDeclared({ official: 400_000, ompCatalog: 1_000_000 })
    expect(r.value).toBe(400_000)
    expect(r.confidence).toBe('inferred')
  })

  it('single BotCF value is documented', () => {
    const r = resolveDeclared({ botcf: 1_000_000 })
    expect(r.value).toBe(1_000_000)
    expect(r.confidence).toBe('documented')
  })

  it('official docs alone are documented', () => {
    const r = resolveDeclared({ official: 200_000 })
    expect(r.value).toBe(200_000)
    expect(r.confidence).toBe('documented')
  })

  it('omp catalog alone is only inferred', () => {
    const r = resolveDeclared({ ompCatalog: 128_000 })
    expect(r.confidence).toBe('inferred')
  })

  it('nothing known falls back conservatively as inferred', () => {
    const r = resolveDeclared({})
    expect(r.value).toBe(FALLBACK_CONTEXT)
    expect(r.confidence).toBe('inferred')
    expect(r.source).toBe('fallback')
  })

  it('agreeing sources keep the agreed value', () => {
    const r = resolveDeclared({ official: 200_000, ompCatalog: 200_000 })
    expect(r.value).toBe(200_000)
    expect(r.confidence).toBe('documented')
  })
})

describe('compactionThreshold', () => {
  it('never equals the raw window', () => {
    expect(compactionThreshold(1_000_000, 8_192)).toBeLessThan(1_000_000)
  })

  it('is ~85-90% of usable input for the verified 1M route', () => {
    const t = compactionThreshold(1_000_000, 8_192)
    const usable = 1_000_000 - 8_192 - 16_000
    expect(t).toBe(Math.floor(usable * 0.875))
    expect(t).toBeGreaterThan(800_000)
    expect(t).toBeLessThan(usable)
  })

  it('clamps to zero for tiny windows', () => {
    expect(compactionThreshold(10_000, 8_192)).toBe(0)
  })
})

describe('botcfDocumentedContext', () => {
  it('documents 1M only for gpt-5.6 on codex routes', () => {
    expect(botcfDocumentedContext('⚓codex-plus', 'gpt-5.6-terra')).toBe(1_000_000)
    expect(botcfDocumentedContext('⚓codex-plus', 'gpt-5.5')).toBeUndefined()
    expect(botcfDocumentedContext('claude-kiro', 'gpt-5.6-terra')).toBeUndefined()
  })
})

describe('officialDocumentedContext', () => {
  it('covers well-known families', () => {
    expect(officialDocumentedContext('claude-kiro-x')).toBe(200_000)
    expect(officialDocumentedContext('gemini-2.5-pro')).toBe(1_000_000)
    expect(officialDocumentedContext('gpt-4.1-mini')).toBe(1_000_000)
    expect(officialDocumentedContext('gpt-4o')).toBe(128_000)
    expect(officialDocumentedContext('gpt-5.5')).toBe(400_000)
    expect(officialDocumentedContext('grok-imagine')).toBe(256_000)
  })

  it('unknown families stay undefined (fallback path)', () => {
    expect(officialDocumentedContext('mystery-model')).toBeUndefined()
  })
})
