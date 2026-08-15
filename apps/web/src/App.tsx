import { useCallback, useEffect, useState } from 'react'
import { api, AppStateInfo, OmpUiRequest } from './api'
import Login from './pages/Login'
import Chat from './pages/Chat'
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

  // Persistent OMP event channel: tool confirmations can arrive at any time.
  // Only dialog methods need user action — setWidget/setStatus/notify/setTitle
  // etc. are one-way display updates and must never open a modal.
  useEffect(() => {
    const DIALOG_METHODS = new Set(['confirm', 'select', 'input', 'editor'])
    const es = new EventSource('/api/omp/events')
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; method?: string; id?: string; targetId?: string }
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
  }, [])

  if (error) {
    return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>本地服务不可用: {error}</div>
  }
  if (!state) {
    return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>加载中…</div>
  }
  if (!state.authenticated) {
    return <Login onLoggedIn={refresh} />
  }
  return (
    <div style={{ fontFamily: 'sans-serif', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar state={state} onRouteChanged={refresh} />
      <Chat route={state.route} ompRunning={state.omp.running} />
      {uiRequests.length > 0 && (
        <UiRequestModal
          request={uiRequests[0]}
          onDone={() => setUiRequests((prev) => prev.slice(1))}
        />
      )}
    </div>
  )
}
