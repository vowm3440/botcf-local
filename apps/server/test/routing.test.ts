import { describe, expect, it } from 'vitest'
import { classifyGroup, isSelectableModel, supportedThinkingLevels, modelMatchesGroup } from '../src/catalog/routing.js'
import { normalizeGroupName, groupSlug, dedicatedKeyName, toBearerKey } from '../src/botcf/keys.js'

describe('classifyGroup', () => {
  it('codex groups use the Responses API', () => {
    expect(classifyGroup('⚓codex-plus')).toMatchObject({ apiType: 'responses', usable: true, hidden: false })
    expect(classifyGroup('codex-fast')).toMatchObject({ apiType: 'responses' })
  })

  it('claude-kiro uses Anthropic messages', () => {
    expect(classifyGroup('claude-kiro')).toMatchObject({ apiType: 'messages', usable: true })
  })

  it('Claude-Max is visible but disabled (Claude Code only)', () => {
    const p = classifyGroup('Claude-Max')
    expect(p.usable).toBe(false)
    expect(p.hidden).toBe(false)
  })

  it('Claude-Max-外接 IS usable', () => {
    expect(classifyGroup('Claude-Max-外接').usable).toBe(true)
  })

  it('image/video groups are hidden from the picker', () => {
    expect(classifyGroup('🌆image2-生图-botcf01').hidden).toBe(true)
    expect(classifyGroup('🎥视频生成按秒').hidden).toBe(true)
    expect(classifyGroup('🧠grok-生图-botcf01').hidden).toBe(true)
  })

  it('mixed text groups default to openai-compatible chat', () => {
    expect(classifyGroup('grok-mix')).toMatchObject({ apiType: 'chat', usable: true, hidden: false })
  })
})

describe('normalizeGroupName / slug / key name', () => {
  it('strips emoji decorations', () => {
    expect(normalizeGroupName('⚓codex-plus')).toBe('codex-plus')
    expect(normalizeGroupName('🌆image2-生图-botcf01')).toBe('image2-生图-botcf01')
  })

  it('builds stable dedicated key names', () => {
    const name = dedicatedKeyName('⚓codex-plus')
    expect(name).toMatch(/^omp-local-[a-z0-9-]+-codex-plus$/)
  })

  it('slug is ascii-safe', () => {
    expect(groupSlug('🌆image2-生图-botcf01')).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('toBearerKey', () => {
  it('prefixes bare keys with sk-', () => {
    expect(toBearerKey('hakKabcd')).toBe('sk-hakKabcd')
    expect(toBearerKey('sk-already')).toBe('sk-already')
  })
})

describe('supportedThinkingLevels', () => {
  it('responses routes expose low/medium/high (BotCF documented ∩ OMP levels)', () => {
    expect(supportedThinkingLevels('responses', 'gpt-5.6-terra')).toEqual(['low', 'medium', 'high'])
  })
  it('messages routes include off', () => {
    expect(supportedThinkingLevels('messages', 'claude-kiro')).toEqual(['off', 'low', 'medium', 'high'])
  })
  it('chat routes pick thinking via model id, so no separate levels', () => {
    expect(supportedThinkingLevels('chat', 'gemini-2.5-pro-nothinking')).toEqual([])
    expect(supportedThinkingLevels('chat', 'gpt-4o')).toEqual([])
  })
})

describe('modelMatchesGroup', () => {
  it('codex groups only serve gpt/codex families', () => {
    expect(modelMatchesGroup('⚓codex-plus', 'gpt-5.6-terra')).toBe(true)
    expect(modelMatchesGroup('⚓codex-plus', 'codex-auto-review')).toBe(true)
    expect(modelMatchesGroup('⚓codex-plus', 'gemini-2.5-pro')).toBe(false)
    expect(modelMatchesGroup('⚓codex-plus', 'claude-kiro')).toBe(false)
  })

  it('claude groups only serve claude models', () => {
    expect(modelMatchesGroup('claude-kiro', 'claude-kiro')).toBe(true)
    expect(modelMatchesGroup('claude-kiro', 'gpt-5.6-terra')).toBe(false)
  })

  it('mixed/unknown groups keep everything', () => {
    expect(modelMatchesGroup('grok-mix', 'gemini-2.5-pro')).toBe(true)
    expect(modelMatchesGroup('some-new-group', 'anything')).toBe(true)
  })
})
