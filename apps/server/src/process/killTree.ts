import { ChildProcess, spawn } from 'node:child_process'

/** Kill a child process *and everything it started*.
 *
 *  Every child we spawn (dev servers, tasks, shells) launches grandchildren:
 *  npm/pnpm shims on Windows, and shell pipelines everywhere else. Killing only
 *  the direct child leaves those holding ports and file handles — Windows never
 *  reaps them — so both platforms need a tree kill:
 *    win32 — `taskkill /T /F` walks the process tree by pid;
 *    posix — the child is spawned `detached`, so it owns a process group and a
 *            negative pid signals the whole group.
 *
 *  Resolves once the process is gone, or after `waitMs` so a wedged tree can
 *  never block shutdown. */

export interface KillTreeOptions {
  /** Escalate to SIGKILL after this long (POSIX only). */
  escalateMs?: number
  /** Give up waiting after this long and resolve anyway. */
  waitMs?: number
}

export async function killTree(child: ChildProcess, options: KillTreeOptions = {}): Promise<void> {
  const { escalateMs = 4_000, waitMs = 6_000 } = options
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null) return

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGTERM')
    }
  } catch {
    // Already dead, or the group vanished — fall through to the timers.
  }

  const escalate = setTimeout(() => {
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }, escalateMs)
  escalate.unref?.()

  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs)
    timer.unref?.()
  })

  await Promise.race([exited, timeout])
  clearTimeout(escalate)
}
