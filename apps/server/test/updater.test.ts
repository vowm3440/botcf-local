import { describe, expect, it } from 'vitest'
import { planSwap, releaseEligible, shouldRollback, normalizeRepoInput, normalizeReleaseSha256, validateReleaseVersion, UpdateState } from '../src/omp/updater.js'

const base: UpdateState = {
  currentVersion: 'v17.2.1',
  previousVersion: null,
  channel: 'fast',
  lastCheckedAt: null,
  lastError: null,
  latestUpstream: null,
  repo: null
}

describe('normalizeRepoInput', () => {
  it('accepts a plain owner/repo', () => {
    expect(normalizeRepoInput('can1357/oh-my-pi')).toBe('can1357/oh-my-pi')
  })

  it('converts full-width slashes from CJK IMEs', () => {
    expect(normalizeRepoInput('can1357／oh-my-pi')).toBe('can1357/oh-my-pi')
  })

  it('strips whitespace and zero-width characters', () => {
    const zw = String.fromCharCode(0x200b)
    expect(normalizeRepoInput(` can1357/${zw}oh-my-pi \n`)).toBe('can1357/oh-my-pi')
  })

  it('accepts pasted GitHub URLs and .git suffixes', () => {
    expect(normalizeRepoInput('https://github.com/can1357/oh-my-pi')).toBe('can1357/oh-my-pi')
    expect(normalizeRepoInput('https://github.com/can1357/oh-my-pi.git')).toBe('can1357/oh-my-pi')
    expect(normalizeRepoInput('can1357/oh-my-pi/')).toBe('can1357/oh-my-pi')
  })

  it('rejects non-official updater repositories', () => {
    expect(() => normalizeRepoInput('attacker/omp')).toThrow(/官方仓库/)
  })
})

describe('planSwap', () => {
  it('remembers the OLD current as previous (regression: rollback used to be a no-op)', () => {
    const next = planSwap(base, 'v17.3.0')
    expect(next.currentVersion).toBe('v17.3.0')
    expect(next.previousVersion).toBe('v17.2.1')
  })

  it('rollback via planSwap restores the old version', () => {
    const upgraded = planSwap(base, 'v17.3.0')
    const rolledBack = planSwap(upgraded, upgraded.previousVersion!)
    expect(rolledBack.currentVersion).toBe('v17.2.1')
    expect(rolledBack.previousVersion).toBe('v17.3.0')
  })

  it('does not mutate the input state', () => {
    planSwap(base, 'v17.3.0')
    expect(base.currentVersion).toBe('v17.2.1')
  })
})

describe('releaseEligible', () => {
  const now = 1_800_000_000_000
  it('fast channel waits ~15 minutes', () => {
    expect(releaseEligible(now - 5 * 60_000, 'fast', now)).toBe(false)
    expect(releaseEligible(now - 20 * 60_000, 'fast', now)).toBe(true)
  })
  it('stable channel waits ~24 hours', () => {
    expect(releaseEligible(now - 60 * 60_000, 'stable', now)).toBe(false)
    expect(releaseEligible(now - 25 * 60 * 60_000, 'stable', now)).toBe(true)
  })
  it('experimental is immediate', () => {
    expect(releaseEligible(now, 'experimental', now)).toBe(true)
  })
})

describe('shouldRollback', () => {
  it('rolls back at the failure threshold', () => {
    expect(shouldRollback(0)).toBe(false)
    expect(shouldRollback(2)).toBe(false)
    expect(shouldRollback(3)).toBe(true)
  })
})

describe('release artifact validation', () => {
  it('rejects traversal in release tags', () => {
    expect(() => validateReleaseVersion('../../escape')).toThrow(/版本标签/)
    expect(validateReleaseVersion('v17.3.4')).toBe('v17.3.4')
  })

  it('requires a complete SHA256 digest', () => {
    expect(() => normalizeReleaseSha256(undefined)).toThrow(/SHA256/)
    expect(normalizeReleaseSha256('A'.repeat(64))).toBe('a'.repeat(64))
  })
})
