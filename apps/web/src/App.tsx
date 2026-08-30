import { useCallback, useEffect, useState } from 'react'
import { api, AppStateInfo, OmpUiRequest, OmpUpdateEvent } from './api'
import Login from './pages/Login'
import Workbench from './pages/Workbench'
import TopBar from './components/TopBar'
import UiRequestModal from './components/UiRequestModal'

export default function App() {
  const [state, setState] = useState<AppStateInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uiRequests, setUiRequests] = useState<OmpUiRequest[]>([])

  const refresh = useCallback(async () => {
    try {
      setState(await api.state())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法连接本地服务')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (state || !error) return
    const timer = window.setTimeout(refresh, 2_000)
    return () => window.clearTimeout(timer)
  }, [error, refresh, state])

  // Startup restoration runs after the HTTP server is up, so the first state we
  // read can carry a not-yet-restored route. The server pushes state_changed
  // when it finishes; this poll covers the window before the event channel is
  // connected, and stops as soon as `restoring` clears.
  useEffect(() => {
    if (!state?.restoring) return
    const timer = window.setTimeout(refresh, 1_000)
    return () => window.clearTimeout(timer)
  }, [refresh, state])

  // Persistent OMP event channel: tool confirmations can arrive at any time.
  // Only dialog methods need user action — setWidget/setStatus/notify/setTitle
  // etc. are one-way display updates and must never open a modal.
  useEffect(() => {
    const DIALOG_METHODS = new Set(['confirm', 'select', 'input', 'editor'])
    const es = new EventSource('/api/omp/events')
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; method?: string; id?: string; targetId?: string }
        if (msg.type === 'state_changed') {
          // Route restored (or definitively failed) on the server side.
          refresh()
          return
        }
        if (msg.type === 'omp_update') {
          const update = msg as unknown as OmpUpdateEvent
          // TopBar consumes this for instant version/status display.
          window.dispatchEvent(new CustomEvent('botcf:omp-update', { detail: update }))
          // Re-sync state.omp (running/available) once the runtime actually changed.
          if (update.phase === 'switched' || update.phase === 'rolled-back') refresh()
          return
        }
        if (msg.type !== 'extension_ui_request') return
        if (msg.method === 'cancel') {
          const target = msg.targetId ?? msg.id
          setUiRequests((prev) => prev.filter((r) => r.id !== target))
          return
        }
        if (msg.method && DIALOG_METHODS.has(msg.method)) {
          setUiRequests((prev) => [...prev, msg as OmpUiRequest])
        }
      } catch {
        /* ignore malformed frames */
      }
    }
    return () => es.close()
  }, [refresh])

  if (error && !state) {
    return <div style={{ padding: 40 }}>本地服务暂时不可用: {error}<br />正在自动重试…</div>
  }
  if (!state) {
    return <div style={{ padding: 40 }}>加载中…</div>
  }
  if (!state.authenticated) {
    return <Login onLoggedIn={refresh} />
  }
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar state={state} onRouteChanged={refresh} />
      <Workbench
        route={state.route}
        ompRunning={state.omp.running}
        accessMode={state.omp.accessMode}
        logsAvailable={state.mode === 'botcf'}
      />
      {uiRequests.length > 0 && (
        <UiRequestModal
          request={uiRequests[0]}
          onDone={() => setUiRequests((prev) => prev.slice(1))}
        />
      )}
    </div>
  )
}
