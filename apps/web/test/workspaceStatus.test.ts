import { describe, expect, it } from 'vitest'
import { workspaceStatus, type WorkspaceStatus } from '../src/workspace/status'

/** The file panel has to answer 「工作区里有几个目录」 while the answer is not known
 *  yet, and while it may never arrive. Both of those used to leak into the count:
 *  an unanswered first request rendered as 「0/8 个目录」, and a request that had run
 *  out of retries kept the header on 「读取中…」 above its own error banner. One value
 *  drives both the header and the body, so this is where that stays honest. */

const ALL: readonly WorkspaceStatus[] = ['loading', 'failed', 'ready']

describe('workspaceStatus', () => {
  it('is loading while the first listing is still being retried', () => {
    expect(workspaceStatus({ loaded: false, failed: false })).toBe('loading')
  })

  it('is failed once the retries gave up — not still loading', () => {
    expect(workspaceStatus({ loaded: false, failed: true })).toBe('failed')
  })

  it('is ready only after a listing actually came back', () => {
    expect(workspaceStatus({ loaded: true, failed: false })).toBe('ready')
  })

  it('stays ready when a later refresh fails — the roots on screen are still real', () => {
    // The refresh failure is reported by the error banner; throwing the tree away and
    // claiming the workspace is unreadable would lose data the panel already has.
    expect(workspaceStatus({ loaded: true, failed: true })).toBe('ready')
  })

  it('answers with exactly one of the three states for every input', () => {
    for (const loaded of [false, true]) {
      for (const failed of [false, true]) {
        const status = workspaceStatus({ loaded, failed })
        expect(ALL.filter((candidate) => candidate === status)).toHaveLength(1)
      }
    }
  })
})
