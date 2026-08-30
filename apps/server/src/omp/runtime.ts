import { appState, applyActiveRouteToOmp } from '../appState.js'
import { diagnosticsCenter } from '../diagnostics/center.js'
import { ompClient } from './rpc.js'

/** The one way to bring the agent runtime back up.
 *
 *  A restart is not finished when the RPC handshake answers. OMP persists its own
 *  model selection and restores it on start, so a process that came back with last
 *  week's provider will happily take a `messages` request on a `chat` route — and
 *  the credential proxy answers 409 while the UI still shows the route the user
 *  picked. The invariant `applyActiveRouteToOmp` documents (every restart
 *  re-applies *and* re-verifies the active route) therefore lives here, not in each
 *  caller: switching the primary root, restarting explicitly and swapping versions
 *  are three call sites, and the one that re-implemented half of it is how the
 *  route went missing.
 *
 *  When the route cannot be reasserted the process is stopped rather than left
 *  running with a model nobody selected: direct mode still honours the active
 *  route, a mismatched agent process does not. */

export type RuntimeRestart =
  /** Process is up, handshook, and carrying the active route (or there is none). */
  | { status: 'restarted'; error: null }
  /** No OMP binary — direct mode. Nothing was restarted, and nothing failed. */
  | { status: 'unavailable'; error: null }
  | { status: 'failed'; error: string }

/** Seam for tests: every step the restart transaction is made of. */
export interface RuntimeControl {
  available: () => boolean
  stop: () => Promise<void>
  start: () => Promise<boolean>
  handshake: () => Promise<boolean>
  lastError: () => string | null
  /** False when no route has been chosen yet (fresh install, not an error). */
  hasRoute: () => boolean
  applyRoute: () => Promise<boolean>
  onFailure?: (error: string) => void
}

export const liveRuntime: RuntimeControl = {
  available: () => ompClient.available,
  stop: () => ompClient.stop(),
  start: () => ompClient.start(),
  handshake: () => ompClient.handshake(),
  lastError: () => ompClient.lastProtocolError,
  hasRoute: () => appState.route !== null,
  applyRoute: () => applyActiveRouteToOmp(),
  onFailure: (error) => {
    diagnosticsCenter.note({ origin: 'agent', source: 'OMP 运行时', message: `运行时重启失败,已降级直连模式: ${error}`, tool: 'omp' })
  }
}

async function failed(control: RuntimeControl, error: string): Promise<RuntimeRestart> {
  await control.stop().catch(() => undefined)
  control.onFailure?.(error)
  return { status: 'failed', error }
}

/** stop → start → handshake → re-apply the active route → verify. Any step that
 *  fails leaves the runtime stopped and reports why; only a complete pass counts
 *  as restarted. */
export async function restartRuntime(control: RuntimeControl = liveRuntime): Promise<RuntimeRestart> {
  await control.stop()
  if (!control.available()) return { status: 'unavailable', error: null }
  if (!(await control.start())) return failed(control, control.lastError() ?? 'OMP 启动失败')
  if (!(await control.handshake())) return failed(control, control.lastError() ?? 'RPC 握手失败')
  if (!control.hasRoute()) return { status: 'restarted', error: null }
  try {
    if (!(await control.applyRoute())) return failed(control, control.lastError() ?? '活动路由未能重新应用')
  } catch (err: unknown) {
    return failed(control, err instanceof Error ? err.message : String(err))
  }
  return { status: 'restarted', error: null }
}
