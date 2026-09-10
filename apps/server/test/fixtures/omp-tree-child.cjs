'use strict'

/** Real process spawned by omp-rpc-lifecycle.test.ts through OmpRpcClient.
 *
 *  stop() must reap not only this process but the grandchild it starts — the
 *  whole point of the tree-kill lifecycle test. The grandchild is deliberately
 *  NOT detached: on POSIX it has to stay in this process's group so the
 *  negative-pid signal reaches it, and on Windows it has to remain a descendant
 *  for `taskkill /T`.
 *
 *  Both pids are written as JSON to the file named by OMP_TREE_PID_FILE, then
 *  this process holds its stdio open until it is killed. */

const { spawn } = require('node:child_process')
const fs = require('node:fs')

const pidFile = process.env.OMP_TREE_PID_FILE
if (!pidFile) throw new Error('OMP_TREE_PID_FILE is required')

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' })
grandchild.unref()

fs.writeFileSync(pidFile, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }))
setInterval(() => {}, 1_000)
