/** What the file panel currently knows about the workspace listing.
 *
 *  Loading, failed and ready are three different things and exactly one of them is
 *  true at a time. Keeping that in one value is what stops the panel from saying two
 *  of them at once: an unanswered request is not an empty workspace (rendering it as
 *  one is how a reload right after a primary-root switch flashed 「0/8 个目录」 over a
 *  workspace that had roots), and a listing that has run out of retries is not still
 *  loading (leaving it as one is how the header kept saying 「读取中…」 above an error
 *  banner). The header and the body read the same value, so they cannot disagree. */

export type WorkspaceStatus = 'loading' | 'failed' | 'ready'

/** `loaded` wins on purpose: once a listing has landed, the roots on screen are
 *  real, and a *later* refresh that failed is reported by the error banner rather
 *  than by throwing away the tree and claiming the workspace is unreadable. */
export function workspaceStatus(input: { loaded: boolean; failed: boolean }): WorkspaceStatus {
  if (input.loaded) return 'ready'
  return input.failed ? 'failed' : 'loading'
}
