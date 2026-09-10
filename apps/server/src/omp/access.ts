import { getSetting, putSetting } from '../db.js'

/** Tool-approval mode — the honest scope of "full access".
 *
 *  OMP's RPC protocol has no permission command: the runtime itself decides what
 *  to run, and the only place the *host* gets a say is the extension-UI
 *  sub-protocol, where an extension asks a `confirm` question and waits for an
 *  `extension_ui_response`. So there are exactly two modes this app can offer:
 *
 *  - `ask`  — a confirm question becomes a modal and the run waits for the user.
 *  - `full` — the host answers `confirmed: true` immediately and the run never
 *             pauses. This does NOT widen what the agent may touch; it removes
 *             the prompt in front of what it was already able to do.
 *
 *  `select`/`input`/`editor` dialogs are never auto-answered: they ask for
 *  content, and inventing an answer is not approval. */

export type AccessMode = 'ask' | 'full'

export const ACCESS_MODE_SETTING = 'omp.accessMode'

/** Dialog methods that need a human. Display-only extension methods
 *  (setWidget/setStatus/notify/…) are not in here and must never open a modal. */
export const DIALOG_METHODS: readonly string[] = ['confirm', 'select', 'input', 'editor']

export function parseAccessMode(value: string | null | undefined): AccessMode {
  return value === 'full' ? 'full' : 'ask'
}

/** Read once, then serve from memory: `/api/state` is polled by the UI and every
 *  forwarded OMP event consults this, while the value changes about once a month.
 *  A store that is not ready yet reads as the safe default rather than throwing
 *  from a status endpoint. */
let cached: AccessMode | null = null

export function getAccessMode(): AccessMode {
  if (cached !== null) return cached
  try {
    const mode = parseAccessMode(getSetting(ACCESS_MODE_SETTING))
    cached = mode
    return mode
  } catch {
    return 'ask'
  }
}

export function setAccessMode(mode: AccessMode): void {
  putSetting(ACCESS_MODE_SETTING, mode)
  cached = mode
}

/** Whether the host answers this frame instead of the user.
 *
 *  Pure on purpose: the auto-approver and the SSE forwarder both call it on the
 *  same frame inside the same synchronous emit, so they agree on the outcome
 *  without sharing any bookkeeping about which ids were already answered. */
export function shouldAutoApprove(msg: Record<string, unknown>, mode: AccessMode): boolean {
  return (
    mode === 'full'
    && msg.type === 'extension_ui_request'
    && msg.method === 'confirm'
    && typeof msg.id === 'string'
    && msg.id !== ''
  )
}

/** One-line description of what was approved, for the transcript. */
export function autoApprovalLabel(msg: Record<string, unknown>): string {
  const title = typeof msg.title === 'string' ? msg.title.trim() : ''
  const message = typeof msg.message === 'string' ? msg.message.trim().replace(/\s+/g, ' ') : ''
  const detail = title || message
  return detail ? `已自动允许:${detail.slice(0, 120)}` : '已自动允许一次工具确认'
}

let installed = false

/** What the auto-approver needs of a runtime: event delivery plus the answer
 *  channel. Both the concrete per-root OmpRpcClient instances and the exported
 *  ActiveOmpClient facade satisfy it structurally. */
export interface OmpEventSink {
  on(event: 'event', listener: (msg: Record<string, unknown>) => void): unknown
  off(event: 'event', listener: (msg: Record<string, unknown>) => void): unknown
  sendFrame(frame: Record<string, unknown>): void
}

/** Answer confirm dialogs for the whole process, once.
 *
 *  Registered before any SSE client can connect, so this listener always runs
 *  ahead of the per-connection forwarders and the run is never left waiting on a
 *  modal that the forwarder decided to skip. Idempotent: route registration can
 *  happen more than once in a test process, and one approver is enough. */
export function installAutoApproval(client: OmpEventSink): void {
  if (installed) return
  installed = true
  client.on('event', (msg: Record<string, unknown>) => {
    if (!shouldAutoApprove(msg, getAccessMode())) return
    try {
      client.sendFrame({ type: 'extension_ui_response', id: String(msg.id), confirmed: true })
    } catch {
      /* the runtime went away mid-dialog; the request dies with it */
    }
  })
}
