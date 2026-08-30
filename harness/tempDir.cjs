'use strict'

const fs = require('node:fs')

/** Removing a temporary directory on Windows, properly.
 *
 *  A bare `rmSync(dir, { recursive: true, force: true })` is a coin flip here, and the
 *  E2E fixture proved it: its directory is a git repository, git creates the files
 *  under `.git/objects` read-only, and the removal came back EPERM. The rejection then
 *  escaped the run's cleanup and `app.exit` never ran — the harness sat there until it
 *  was killed by hand, which is the exact failure mode every ceiling in this harness
 *  exists to prevent.
 *
 *  Two layers, because they cover different things. `maxRetries` is Node's own: it
 *  retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM with a linear backoff, which is what a
 *  read-only file or a handle that is about to be released needs. The outer loop
 *  covers the rest — Windows can keep a directory undeletable for a moment after the
 *  process that had files in it exits, and no amount of retrying *inside* one call
 *  helps if the process has not finished exiting yet.
 *
 *  Never rejects. A harness that fails to tidy up should say so and exit, not take the
 *  run down with it. */

async function removeDirectory(dir, onFailure) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      return true
    } catch (error) {
      if (attempt >= 9) {
        onFailure?.(error)
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

module.exports = { removeDirectory }
