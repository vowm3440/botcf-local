import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { DetectedProject, PreviewEvent, PreviewLogLine, PreviewMode, PreviewState, WorkspaceRootInfo, api } from '../api'
import { diagnosticsApi } from '../services/diagnostics'
import { onWorkspaceChanged } from '../workspace/events'

/** Sandboxed live-preview panel.
 *
 *  The page is hosted by the server on its own loopback port (static mode: our
 *  built-in host + file watcher; command mode: the project's own dev server) and
 *  rendered here in a sandboxed iframe. Because the preview origin is a
 *  *different port* than the control UI, the sandbox can keep `allow-same-origin`
 *  — the previewed app gets its own storage and its own SSE reload channel, but
 *  still cannot read this app's origin. `allow-top-navigation` is withheld, so a
 *  runaway page cannot navigate the console away. */

const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-same-origin allow-downloads'

const DEVICE_WIDTHS: Array<{ label: string; value: number | 'auto' }> = [
  { label: '自适应', value: 'auto' },
  { label: '手机 375', value: 375 },
  { label: '平板 768', value: 768 },
  { label: '桌面 1280', value: 1280 }
]

const MODE_LABELS: Record<PreviewMode, string> = {
  static: '静态(内置服务器 + 热重载)',
  command: '命令(项目自带 dev server + HMR)'
}

const PHASE_LABELS: Record<PreviewState['phase'], string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  error: '失败'
}

const MONO = 'ui-monospace, Consolas, monospace'

/** Join the host base URL with the user-entered route. */
export function composeUrl(base: string, route: string): string {
  try {
    return new URL(route.replace(/^\/+/, ''), base).toString()
  } catch {
    return base
  }
}

const BUTTON: CSSProperties = {
  fontSize: 12,
  padding: '2px 10px',
  borderRadius: 4,
  border: '1px solid #ccc',
  background: '#fff',
  cursor: 'pointer'
}

export default function PreviewPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<PreviewState | null>(null)
  const [detected, setDetected] = useState<DetectedProject | null>(null)
  const [workdir, setWorkdir] = useState<string | null>(null)
  /** Workspace root to preview. Empty means "let the server pick" — the running
   *  one, else the primary root. One root is previewed at a time. */
  const [rootId, setRootId] = useState('')
  const [roots, setRoots] = useState<WorkspaceRootInfo[]>([])
  const [logs, setLogs] = useState<PreviewLogLine[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [route, setRoute] = useState('/')
  const [deviceWidth, setDeviceWidth] = useState<number | 'auto'>('auto')
  const [mode, setMode] = useState<PreviewMode | 'auto'>('auto')
  const [script, setScript] = useState('')
  const [nonce, setNonce] = useState(0)
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([])
  const logRef = useRef<HTMLPreElement | null>(null)

  const refresh = useCallback(async (targetRoot?: string) => {
    try {
      const status = await api.previewStatus(targetRoot)
      setState(status.state)
      setDetected(status.detected)
      setWorkdir(status.workdir)
      setRoots(status.roots)
      setLogs(status.logs)
      // Adopt the root the server resolved, so the picker shows what would start.
      if (status.root) setRootId(status.root.id)
      setNotice(null)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '预览状态读取失败')
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => undefined)
  }, [refresh])

  // 工作区目录增删/切主目录后,预览目标与项目探测结果都可能变了。
  useEffect(() => onWorkspaceChanged(() => { refresh().catch(() => undefined) }), [refresh])

  // Server-pushed state, dev-server logs and reload pulses.
  useEffect(() => {
    const source = new EventSource('/api/preview/events')
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as PreviewEvent
        if (frame.type === 'preview_state') setState(frame.state)
        if (frame.type === 'preview_log') setLogs((prev) => [...prev.slice(-199), { at: frame.at, line: frame.line }])
        if (frame.type === 'preview_reload') setRuntimeErrors([])
      } catch {
        /* ignore malformed frames */
      }
    }
    return () => source.close()
  }, [])

  // Runtime errors and navigation relayed by the injected reload client.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; message?: string; href?: string } | null
      if (!data || data.source !== 'botcf-preview') return
      if (data.type === 'error' && data.message) {
        const message = data.message
        setRuntimeErrors((prev) => (prev.includes(message) ? prev : [...prev.slice(-9), message]))
        // 页面里抛出的错误服务端看不到,转交诊断中心,和任务/预览报错并列。
        diagnosticsApi.reportRuntime({ message }).catch(() => undefined)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (showLogs && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs, showLogs])

  const running = state?.running === true
  const starting = state?.phase === 'starting'
  const effectiveMode: PreviewMode = mode === 'auto' ? detected?.mode ?? 'static' : mode
  const scripts = detected?.scripts ?? []
  const chosenScript = script || detected?.script || ''

  const start = async () => {
    setBusy(true)
    setNotice(null)
    setRuntimeErrors([])
    try {
      const payload: { mode?: PreviewMode; script?: string; root?: string } = { mode: effectiveMode }
      if (effectiveMode === 'command' && chosenScript) payload.script = chosenScript
      if (rootId) payload.root = rootId
      const res = await api.previewStart(payload)
      setState(res.state)
      setLogs(res.logs)
      if (res.root) setRootId(res.root.id)
      if (effectiveMode === 'command') setShowLogs(true)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '预览启动失败')
      setShowLogs(true)
    } finally {
      setBusy(false)
    }
  }

  /** Switching the target root re-runs project detection for it, so the mode and
   *  script pickers describe the project that would actually start. */
  const selectRoot = (id: string) => {
    setRootId(id)
    setScript('')
    refresh(id).catch(() => undefined)
  }

  const stop = async () => {
    setBusy(true)
    try {
      setState((await api.previewStop()).state)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '预览停止失败')
    } finally {
      setBusy(false)
    }
  }

  const reload = async () => {
    setRuntimeErrors([])
    // Remount the iframe (works in both modes) and also push a reload to any
    // page attached to the built-in static host.
    setNonce((prev) => prev + 1)
    if (running) await api.previewReload().catch(() => undefined)
  }

  const iframeUrl = useMemo(() => (state?.url ? composeUrl(state.url, route) : null), [route, state?.url])

  const statusLine = useMemo(() => {
    if (!state) return '读取状态…'
    const parts = [PHASE_LABELS[state.phase]]
    if (state.mode) parts.push(state.mode === 'static' ? '静态' : '命令')
    if (state.command) parts.push(state.command)
    if (state.url) parts.push(state.url)
    if (state.mode === 'static' && state.clients > 0) parts.push(`${state.clients} 个预览页已连接`)
    if (state.lastReloadAt) {
      parts.push(`${state.lastReloadKind === 'css' ? '样式热更新' : '重载'} ${new Date(state.lastReloadAt).toLocaleTimeString()}`)
    }
    return parts.join(' · ')
  }, [state])

  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid #f0f0f0' }}>
        {running || starting ? (
          <button onClick={() => { stop().catch(() => undefined) }} disabled={busy} style={{ ...BUTTON, border: '1px solid #d33', color: '#d33' }}>
            停止
          </button>
        ) : (
          <button onClick={() => { start().catch(() => undefined) }} disabled={busy || !workdir} style={{ ...BUTTON, border: '1px solid #2a7d46', color: '#2a7d46', fontWeight: 600 }}>
            {busy ? '启动中…' : '启动预览'}
          </button>
        )}
        {roots.length > 1 && (
          <select
            aria-label="预览目录"
            value={rootId}
            onChange={(event) => selectRoot(event.target.value)}
            disabled={running || starting}
            title="要预览的工作区目录(一次预览一个)"
            style={{ fontSize: 12, maxWidth: 140 }}
          >
            {roots.map((root) => (
              <option key={root.id} value={root.id} disabled={!root.exists}>
                {root.name}{root.primary ? ' (主)' : ''}{root.exists ? '' : '(不存在)'}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="预览模式"
          value={mode}
          onChange={(event) => setMode(event.target.value as PreviewMode | 'auto')}
          disabled={running || starting}
          style={{ fontSize: 12, maxWidth: 260 }}
        >
          <option value="auto">自动{detected ? `(${detected.mode === 'static' ? '静态' : '命令'})` : ''}</option>
          <option value="static">{MODE_LABELS.static}</option>
          <option value="command">{MODE_LABELS.command}</option>
        </select>
        {effectiveMode === 'command' && scripts.length > 0 && (
          <select
            aria-label="dev 脚本"
            value={chosenScript}
            onChange={(event) => setScript(event.target.value)}
            disabled={running || starting}
            style={{ fontSize: 12, maxWidth: 160 }}
          >
            {scripts.map((name) => (
              <option key={name} value={name}>
                {detected?.packageManager} run {name}
              </option>
            ))}
          </select>
        )}
        <input
          value={route}
          onChange={(event) => setRoute(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') reload().catch(() => undefined)
          }}
          aria-label="预览路径"
          placeholder="/"
          spellCheck={false}
          style={{ flex: 1, minWidth: 80, fontSize: 12, fontFamily: MONO, padding: '2px 6px', border: '1px solid #ccc', borderRadius: 4 }}
        />
        <button onClick={() => { reload().catch(() => undefined) }} disabled={!running} style={BUTTON} title="重新加载预览">
          刷新
        </button>
        <button
          onClick={() => { if (iframeUrl) window.open(iframeUrl, '_blank', 'noopener,noreferrer') }}
          disabled={!iframeUrl}
          style={BUTTON}
          title="在系统浏览器中打开"
        >
          外部打开
        </button>
        <select
          aria-label="预览宽度"
          value={String(deviceWidth)}
          onChange={(event) => setDeviceWidth(event.target.value === 'auto' ? 'auto' : Number(event.target.value))}
          style={{ fontSize: 12 }}
        >
          {DEVICE_WIDTHS.map((entry) => (
            <option key={entry.label} value={String(entry.value)}>
              {entry.label}
            </option>
          ))}
        </select>
        <button onClick={() => setShowLogs((prev) => !prev)} style={BUTTON}>
          {showLogs ? '隐藏日志' : `日志${logs.length > 0 ? ` (${logs.length})` : ''}`}
        </button>
        <button onClick={onClose} style={BUTTON} aria-label="关闭预览面板">
          ✕
        </button>
      </div>

      <div style={{ padding: '3px 8px', fontSize: 11, color: state?.phase === 'error' ? '#c00' : '#666', borderBottom: '1px solid #f6f6f6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={statusLine}>
        {notice ?? state?.error ?? statusLine}
      </div>

      {runtimeErrors.length > 0 && (
        <div style={{ padding: '4px 8px', fontSize: 11, color: '#c00', background: '#fff5f5', borderBottom: '1px solid #ffe0e0', maxHeight: 66, overflowY: 'auto' }}>
          {runtimeErrors.map((message, index) => (
            <div key={index} style={{ fontFamily: MONO, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {message}
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center', background: deviceWidth === 'auto' ? '#fff' : '#eceff1', overflow: 'auto' }}>
        {iframeUrl && (running || starting) ? (
          <iframe
            key={`${iframeUrl}#${nonce}`}
            src={iframeUrl}
            title="实时预览"
            sandbox={SANDBOX}
            style={{
              border: 'none',
              width: deviceWidth === 'auto' ? '100%' : deviceWidth,
              maxWidth: '100%',
              height: '100%',
              background: '#fff',
              boxShadow: deviceWidth === 'auto' ? undefined : '0 0 0 1px #cfd8dc'
            }}
          />
        ) : (
          <div style={{ padding: 16, fontSize: 12, color: '#666', lineHeight: 1.8, alignSelf: 'flex-start' }}>
            {!workdir && <div>工作区还没有目录。先在文件面板「添加目录」加入项目目录,预览才能启动。</div>}
            {workdir && (
              <>
                <div style={{ fontFamily: MONO, color: '#888' }}>{workdir}</div>
                {detected && <div>{detected.reason}</div>}
                <div style={{ color: '#888' }}>
                  静态模式由内置服务器托管并监听文件改动(仅样式改动时热替换 CSS,其余整页重载);
                  命令模式运行项目自带的 dev server,由其自身的 HMR 负责增量更新。
                </div>
                {state?.phase === 'starting' && <div>正在启动…</div>}
              </>
            )}
          </div>
        )}
      </div>

      {showLogs && (
        <pre
          ref={logRef}
          style={{
            margin: 0,
            padding: 8,
            maxHeight: 180,
            minHeight: 60,
            overflow: 'auto',
            background: '#0f1115',
            color: '#d7dae0',
            fontFamily: MONO,
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            borderTop: '1px solid #ddd',
            flex: 'none'
          }}
        >
          {logs.length === 0 ? '(暂无日志)' : logs.map((entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.line}`).join('\n')}
        </pre>
      )}
    </div>
  )
}
