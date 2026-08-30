import { useEffect, useMemo, useState } from 'react'
import { BUTTON, EMPTY_HINT, INPUT, MONO, PANEL_BODY, ROW, SCROLL_AREA, STATUS_LINE, TOOLBAR, formatAge } from './ui'
import { requestOpenFile } from '../editor/openFile'
import {
  ORIGIN_LABELS,
  SEVERITY_LABELS,
  diagnosticsApi,
  type Diagnostic,
  type DiagnosticOrigin,
  type DiagnosticSeverity,
  type DiagnosticsResponse
} from '../services/diagnostics'

/** Errors & diagnostics center.
 *
 *  One ranked list for everything that failed: compiler/linter/test output parsed
 *  out of task runs, dev-server and preview failures, agent tool errors, and
 *  runtime errors relayed from the previewed page. Errors sort above warnings,
 *  identical findings collapse with a repeat count, and a finding with a location
 *  opens the file at that line. */

const SEVERITY_STYLE: Record<DiagnosticSeverity, { mark: string; color: string }> = {
  error: { mark: '✖', color: '#cf222e' },
  warning: { mark: '⚠', color: '#9a6700' },
  info: { mark: 'ℹ', color: '#0969da' }
}

export default function DiagnosticsPanel() {
  const [data, setData] = useState<DiagnosticsResponse | null>(null)
  const [origin, setOrigin] = useState<DiagnosticOrigin | ''>('')
  const [severity, setSeverity] = useState<DiagnosticSeverity | ''>('')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  // The center pushes the whole list on change (coalesced server-side), so the
  // panel never needs to poll and never shows a stale count.
  useEffect(() => {
    const source = new EventSource(diagnosticsApi.eventsUrl())
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as { type?: string } & DiagnosticsResponse
        if (frame.type === 'diagnostics') setData(frame)
      } catch {
        /* ignore malformed frames */
      }
    }
    source.onerror = () => setNotice('诊断事件流中断,正在自动重连…')
    source.onopen = () => setNotice(null)
    return () => source.close()
  }, [])

  const items = useMemo(() => {
    const query = search.trim().toLowerCase()
    return (data?.items ?? [])
      .filter((item) => !origin || item.origin === origin)
      .filter((item) => !severity || item.severity === severity)
      .filter(
        (item) =>
          !query ||
          item.message.toLowerCase().includes(query) ||
          (item.path ?? '').toLowerCase().includes(query) ||
          item.source.toLowerCase().includes(query)
      )
  }, [data, origin, severity, search])

  const summary = data?.summary
  const open = (item: Diagnostic): void => {
    if (!item.path) return
    requestOpenFile({ path: item.path, line: item.line, column: item.column })
  }

  return (
    <div style={PANEL_BODY}>
      <div style={TOOLBAR}>
        <select
          aria-label="来源"
          value={origin}
          onChange={(event) => setOrigin(event.target.value as DiagnosticOrigin | '')}
          style={{ fontSize: 12 }}
        >
          <option value="">全部来源</option>
          {(data?.origins ?? []).map((value) => (
            <option key={value} value={value}>
              {ORIGIN_LABELS[value]} ({summary?.byOrigin[value] ?? 0})
            </option>
          ))}
        </select>
        <select
          aria-label="级别"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as DiagnosticSeverity | '')}
          style={{ fontSize: 12 }}
        >
          <option value="">全部级别</option>
          <option value="error">错误 ({summary?.errors ?? 0})</option>
          <option value="warning">警告 ({summary?.warnings ?? 0})</option>
          <option value="info">提示 ({summary?.infos ?? 0})</option>
        </select>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="过滤文件或信息…"
          aria-label="过滤诊断"
          style={{ ...INPUT, flex: 1, minWidth: 100 }}
        />
        <button
          style={BUTTON}
          onClick={() => {
            diagnosticsApi
              .clear(origin ? { origin } : {})
              .then((result) => setData(result))
              .catch((error: unknown) => setNotice(error instanceof Error ? error.message : '清空失败'))
          }}
        >
          {origin ? `清空「${ORIGIN_LABELS[origin]}」` : '全部清空'}
        </button>
      </div>

      <div style={{ ...STATUS_LINE, color: notice ? '#c00' : '#666' }}>
        {notice ??
          (summary
            ? `${summary.total} 条 · 错误 ${summary.errors} · 警告 ${summary.warnings} · 提示 ${summary.infos}`
            : '连接诊断中心…')}
      </div>

      <div style={SCROLL_AREA}>
        {items.length === 0 ? (
          <div style={EMPTY_HINT}>
            目前没有诊断信息。运行构建/测试任务、启动预览或让 AI 执行工具时,
            出现的编译错误、失败的任务、预览报错与工具失败都会汇总到这里,点击即可跳到对应文件行。
          </div>
        ) : (
          items.map((item) => {
            const style = SEVERITY_STYLE[item.severity]
            return (
              <div key={item.id} style={{ ...ROW, alignItems: 'flex-start' }}>
                <span style={{ flex: 'none', color: style.color, fontWeight: 600 }} title={SEVERITY_LABELS[item.severity]}>
                  {style.mark}
                </span>
                <span style={{ flex: 'none', fontSize: 10, color: '#8c959f', border: '1px solid #eee', borderRadius: 3, padding: '0 4px' }}>
                  {ORIGIN_LABELS[item.origin]}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflowWrap: 'anywhere' }}>
                    {item.message}
                    {item.count > 1 && <span style={{ marginLeft: 6, fontSize: 10, color: '#8c959f' }}>×{item.count}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: '#8c959f', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span>{item.source}</span>
                    {item.code && <span>{item.code}</span>}
                    {item.path && (
                      <button
                        onClick={() => open(item)}
                        title="在编辑器中打开这一行"
                        style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: '#0969da', fontFamily: MONO, fontSize: 11 }}
                      >
                        {item.path}
                        {item.line ? `:${item.line}` : ''}
                        {item.column ? `:${item.column}` : ''}
                      </button>
                    )}
                    <span>{formatAge(item.lastAt)}</span>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
