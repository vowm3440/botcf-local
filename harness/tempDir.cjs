'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Removing a temporary directory on Windows, properly.
 *
 *  A bare `rmSync(dir, { recursive: true, force: true })` is a coin flip here, and the
 *  E2E fixture proved it twice. Its directory is a git repository, git creates
 *  everything under `.git/objects` **read-only**, and `force: true` covers "the path
 *  does not exist" — not permissions. The first failure took the run's exit with it;
 *  the second was quieter and worse: the removal returned false, nobody looked at the
 *  result, the run reported a clean teardown, and the *next* run died in `create()`
 *  against the directory that was still there.
 *
 *  So three things, in order of how often they are what actually helps:
 *
 *  1. Clear the read-only bit across the tree first. Node's own EPERM retry chmods the
 *     entry it tripped over, which is not the same as chmodding the tree before it
 *     starts — and with git's object store it is thousands of entries.
 *  2. `maxRetries`, Node's own: EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM with a backoff,
 *     for a handle about to be released.
 *  3. An outer loop, because Windows can keep a directory undeletable for a moment
 *     after the process that had files in it exits, and no amount of retrying inside
 *     one call helps if that process has not finished exiting yet.
 *
 *  Returns whether the directory is gone, and never throws. Callers must look at the
 *  answer — that is the whole lesson of the second failure. */

/** Best effort, entry by entry: one unreadable corner must not stop the rest. */
function clearReadOnly(target) {
  let entries
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name)
    try {
      // On Windows chmod only maps the read-only bit, so the mode itself is nominal.
      fs.chmodSync(full, entry.isDirectory() ? 0o777 : 0o666)
    } catch {
      /* keep going */
    }
    if (entry.isDirectory()) clearReadOnly(full)
  }
}

async function removeDirectory(dir, onFailure) {
  if (!fs.existsSync(dir)) return true
  clearReadOnly(dir)
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      return true
    } catch (error) {
      if (attempt >= 9) {
        onFailure?.(error)
        return false
      }
      // Something may have recreated a read-only entry between attempts.
      clearReadOnly(dir)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

module.exports = { removeDirectory, clearReadOnly }
