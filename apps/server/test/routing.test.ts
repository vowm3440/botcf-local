import { describe, expect, it } from 'vitest'
import { classifyGroup, isSelectableModel, supportedThinkingLevels, modelMatchesGroup, normalizeBaseUrl, parseModelList, thirdPartyApiType, THIRD_PARTY_THINKING_LEVELS } from '../src/catalog/routing.js'
import { normalizeGroupName, groupSlug, dedicatedKeyName, toBearerKey } from '../src/botcf/keys.js'

describe('third-party provider helpers', () => {
  it('normalizes base URLs: trims, strips trailing slashes and /v1', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com')
    expect(normalizeBaseUrl('  https://api.example.com/v1  ')).toBe('https://api.example.com')
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com')
    expect(normalizeBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('rejects invalid base URLs', () => {
    expect(normalizeBaseUrl('')).toBeNull()
    expect(normalizeBaseUrl('api.example.com')).toBeNull()
    expect(normalizeBaseUrl('ftp://x')).toBeNull()
    expect(normalizeBaseUrl('https://bad url')).toBeNull()
  })

  it('parses model lists across commas, newlines and spaces, deduped', () => {
    expect(parseModelList('gpt-4o, claude-4-sonnet\n gemini-2.5-pro;gpt-4o')).toEqual([
      'gpt-4o', 'claude-4-sonnet', 'gemini-2.5-pro'
    ])
    expect(parseModelList('  \n ')).toEqual([])
  })

  it('routes claude models to messages and everything else to chat', () => {
    expect(thirdPartyApiType('claude-4-sonnet')).toBe('messages')
    expect(thirdPartyApiType('Claude-Opus')).toBe('messages')
    expect(thirdPartyApiType('gpt-4o')).toBe('chat')
    expect(thirdPartyApiType('glm-5')).toBe('chat')
  })

  it('exposes the unified thinking ladder for third-party routes', () => {
    expect(THIRD_PARTY_THINKING_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('classifyGroup', () => {
  it('codex groups use the Responses API', () => {
    expect(classifyGroup('⚓codex-plus')).toMatchObject({ apiType: 'responses', usable: true, hidden: false })
    expect(classifyGroup('codex-fast')).toMatchObject({ apiType: 'responses' })
  })

  it('claude-kiro uses Anthropic messages', () => {
    expect(classifyGroup('claude-kiro')).toMatchObject({ apiType: 'messages', usable: true })
  })

  it('Claude-Max is selectable but carries a Claude-Code-only warning', () => {
    const p = classifyGroup('Claude-Max')
    expect(p.usable).toBe(true)
    expect(p.hidden).toBe(false)
    expect(p.reason).toBeTruthy()
  })

  it('Claude-Max-外接 IS usable without a warning', () => {
    const p = classifyGroup('Claude-Max-外接')
    expect(p.usable).toBe(true)
    expect(p.reason).toBeUndefined()
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
  it('every route type exposes the unified five-level ladder', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(supportedThinkingLevels('responses', 'gpt-5.6-terra')).toEqual(levels)
    expect(supportedThinkingLevels('messages', 'claude-kiro')).toEqual(levels)
    expect(supportedThinkingLevels('chat', 'gemini-2.5-pro-nothinking')).toEqual(levels)
    expect(supportedThinkingLevels('chat', 'gpt-4o')).toEqual(levels)
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
