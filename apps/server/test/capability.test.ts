import { describe, expect, it } from 'vitest'
import {
  resolveDeclared,
  compactionThreshold,
  botcfDocumentedContext,
  officialDocumentedContext,
  officialMaxOutput,
  resolveMaxOutput,
  DEFAULT_MAX_OUTPUT,
  MIN_MAX_OUTPUT,
  FALLBACK_CONTEXT
} from '../src/catalog/capability.js'

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

describe('officialMaxOutput', () => {
  it('covers the families whose output budget is published', () => {
    expect(officialMaxOutput('gpt-3.5-turbo-16k')).toBe(4_096)
    expect(officialMaxOutput('gpt-4o-mini')).toBe(16_384)
    expect(officialMaxOutput('gpt-4.1')).toBe(32_768)
    expect(officialMaxOutput('gpt-5.2-codex')).toBe(128_000)
    expect(officialMaxOutput('o3-mini-high')).toBe(100_000)
    expect(officialMaxOutput('claude-opus-5')).toBe(64_000)
    expect(officialMaxOutput('gemini-3.5-flash')).toBe(65_536)
  })

  it('unknown families stay undefined so the default applies', () => {
    expect(officialMaxOutput('kimi-k3')).toBeUndefined()
    expect(officialMaxOutput('minimax-m3')).toBeUndefined()
  })
})

/** The regression this guards: every route used to get a flat 8192-token output
 *  budget. A reasoning model spends that budget thinking *before* it emits a tool
 *  call, so the turn came back with stopReason "length" — no text, no tool call —
 *  and the agent loop ended looking like the assistant had simply stopped after
 *  reading a file. */
describe('resolveMaxOutput', () => {
  it('gives a reasoning model far more than the old flat 8K cap', () => {
    expect(resolveMaxOutput('claude-opus-5', 200_000)).toBeGreaterThan(8_192)
    expect(resolveMaxOutput('gpt-5.2-codex', 400_000)).toBeGreaterThan(8_192)
    expect(resolveMaxOutput('kimi-k3', 128_000)).toBeGreaterThan(8_192)
  })

  it('never lets output claim more than a quarter of the window', () => {
    // 64K is documented for claude, but a 200K window only affords 50K.
    expect(resolveMaxOutput('claude-opus-5', 200_000)).toBe(50_000)
    expect(resolveMaxOutput('gpt-5.2-codex', 400_000)).toBe(100_000)
    expect(resolveMaxOutput('mystery-model', 128_000)).toBe(32_000)
  })

  it('keeps a documented family value when the window can afford more', () => {
    expect(resolveMaxOutput('claude-opus-5', 1_000_000)).toBe(64_000)
    expect(resolveMaxOutput('gemini-3.5-flash', 1_000_000)).toBe(65_536)
    expect(resolveMaxOutput('mystery-model', 1_000_000)).toBe(DEFAULT_MAX_OUTPUT)
  })

  it('honours a small documented budget even when the window is large', () => {
    expect(resolveMaxOutput('gpt-3.5-turbo', 128_000)).toBe(4_096)
    expect(resolveMaxOutput('gpt-4o', 128_000)).toBe(16_384)
  })

  it('floors the window share at the historical cap for tiny windows', () => {
    expect(resolveMaxOutput('mystery-model', 16_000)).toBe(MIN_MAX_OUTPUT)
  })

  it('leaves a workable input budget after compaction reserves', () => {
    const output = resolveMaxOutput('claude-opus-5', 200_000)
    expect(compactionThreshold(200_000, output)).toBeGreaterThan(100_000)
  })
})
