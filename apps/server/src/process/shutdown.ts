/** One place that owns SIGINT/SIGTERM.
 *
 *  Several subsystems must let go of child processes before this process dies —
 *  the live preview's dev server, task runs, terminal sessions — and each of them
 *  used to install its own signal handler. That does not compose: a handler that
 *  re-raises the signal after its own cleanup cancels everyone else's. So there
 *  is a single installed handler here. Cleanups run in registration order — the
 *  same order the resources were acquired — and the signal is re-raised once at
 *  the end.
 *
 *  Cleanup is bounded: a wedged process tree must not stop the shutdown. */

export type ShutdownHandler = () => Promise<void> | void

const handlers = new Set<ShutdownHandler>()
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
const CLEANUP_BUDGET_MS = 8_000

let installed = false
let shuttingDown = false

/** Run every registered cleanup in registration order, ignoring failures;
 *  resolves after the budget even if a handler never settles.
 *
 *  Order is load-bearing: release must follow acquisition (cancel the in-flight
 *  AI session before the preview/task/terminal registries tear down their
 *  processes), so server.ts registers shutdown handlers in that order and they
 *  run exactly once each, never racing one another. */
export async function runShutdownHandlers(budgetMs = CLEANUP_BUDGET_MS): Promise<void> {
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, budgetMs)
    timer.unref?.()
  })
  const drain = (async () => {
    for (const handler of [...handlers]) {
      try {
        await handler()
      } catch {
        // A cleanup that fails must not block the others.
      }
    }
  })()
  await Promise.race([drain, deadline])
}

function install(): void {
  if (installed) return
  installed = true
  for (const signal of SIGNALS) {
    process.once(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      runShutdownHandlers()
        .catch(() => undefined)
        .finally(() => {
          // Restore default behaviour for this signal, then let it through so the
          // exit code and the parent's view of the process stay correct.
          for (const other of SIGNALS) process.removeAllListeners(other)
          process.kill(process.pid, signal)
        })
    })
  }
}

/** Register a cleanup; returns the unregister function. */
export function onShutdown(handler: ShutdownHandler): () => void {
  handlers.add(handler)
  install()
  return () => {
    handlers.delete(handler)
  }
}
