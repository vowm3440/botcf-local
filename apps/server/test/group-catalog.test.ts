import { describe, expect, it } from 'vitest'
import { extractPricingGroups, mergeGroups, modelAllowedInGroup } from '../src/catalog/groupCatalog.js'

describe('extractPricingGroups', () => {
  it('collects groups from usable_group, group_ratio and enable_groups', () => {
    const catalog = extractPricingGroups({
      data: [
        { model_name: 'gpt-4o', enable_groups: ['default', 'codex-plus'] },
        { model_name: 'claude-4-sonnet', enable_groups: ['claude'] }
      ],
      group_ratio: { default: 1, vip: 2 },
      usable_group: { default: '默认分组', 'codex-plus': 'Codex 高级' }
    })
    expect(catalog.groups).toEqual(['default', 'codex-plus', 'vip', 'claude'])
    expect(catalog.descriptions).toEqual({ default: '默认分组', 'codex-plus': 'Codex 高级' })
    expect(catalog.modelGroups).toEqual({
      'gpt-4o': ['default', 'codex-plus'],
      'claude-4-sonnet': ['claude']
    })
  })

  it('accepts usable_group as a plain array of names', () => {
    const catalog = extractPricingGroups({ usable_group: ['a', 'b', 42] })
    expect(catalog.groups).toEqual(['a', 'b'])
    expect(catalog.descriptions).toEqual({})
  })

  it('tolerates junk payloads', () => {
    expect(extractPricingGroups(null).groups).toEqual([])
    expect(extractPricingGroups('nope').groups).toEqual([])
    expect(extractPricingGroups({ data: 'not-an-array', group_ratio: 7 }).groups).toEqual([])
    const catalog = extractPricingGroups({
      data: [{ model_name: 42, enable_groups: ['x'] }, { model_name: 'ok', enable_groups: 'not-array' }],
      usable_group: { good: '好', bad: 99 }
    })
    expect(catalog.groups).toEqual(['good', 'bad', 'x'])
    expect(catalog.descriptions).toEqual({ good: '好' })
    expect(catalog.modelGroups).toEqual({})
  })

  it('normalizes model keys to lowercase and group values for matching', () => {
    const catalog = extractPricingGroups({
      data: [{ model_name: 'GPT-4o', enable_groups: ['⚓Codex-Plus'] }]
    })
    expect(catalog.modelGroups['gpt-4o']).toEqual(['codex-plus'])
    expect(catalog.groups).toEqual(['⚓Codex-Plus'])
  })
})

describe('mergeGroups', () => {
  it('deduplicates while preserving first-seen order', () => {
    expect(mergeGroups(['default', 'codex'], ['codex', 'claude', 'default', 'vip'])).toEqual([
      'default', 'codex', 'claude', 'vip'
    ])
  })
})

describe('modelAllowedInGroup', () => {
  const catalog = extractPricingGroups({
    data: [
      { model_name: 'gpt-4o', enable_groups: ['default', 'codex-plus'] },
      { model_name: 'claude-4-sonnet', enable_groups: ['claude-外接'] }
    ]
  })

  it('answers membership for models the catalog knows', () => {
    expect(modelAllowedInGroup('gpt-4o', 'codex-plus', catalog)).toBe(true)
    expect(modelAllowedInGroup('GPT-4o', 'claude-外接', catalog)).toBe(false)
  })

  it('matches groups regardless of emoji decorations and case', () => {
    expect(modelAllowedInGroup('gpt-4o', '⚓Codex-Plus', catalog)).toBe(true)
  })

  it('returns null for models the catalog does not know', () => {
    expect(modelAllowedInGroup('gemini-3-pro', 'default', catalog)).toBeNull()
  })
})
