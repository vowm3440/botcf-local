import { EventEmitter } from 'node:events'

/** Server-pushed hint that `/api/state` changed for a reason the browser could
 *  not have caused itself. Startup restoration is the case that matters: the
 *  route is re-armed asynchronously *after* the HTTP server accepts requests,
 *  so a page that read `route: null` once would keep showing "no model" forever.
 *  The frontend re-reads state on every frame instead of tracking a diff — the
 *  payload is small and the correctness comes from not caching a stale answer. */
export interface StateChangedEvent {
  type: 'state_changed'
  reason: 'route-restored' | 'route-restore-failed'
}

class AppEventBus extends EventEmitter {
  emitStateChanged(reason: StateChangedEvent['reason']): void {
    this.emit('state', { type: 'state_changed', reason } satisfies StateChangedEvent)
  }
}

export const appEvents = new AppEventBus()
