import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import DiffView from './DiffView'

interface FileViewerProps {
  path: string
  /** Session diff for this file, when OMP changed it — enables the 差异 tab. */
  diff?: string
  onClose: () => void
}

interface FileData {
  content: string
  size: number
  truncated: boolean
  binary: boolean
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** Read-only editor drawer: 内容 tab shows the file, 差异 tab shows the
 *  session's unified diff with highlighting. Content refreshes after each turn. */
export default function FileViewer({ path, diff, onClose }: FileViewerProps) {
  const [tab, setTab] = useState<'content' | 'diff'>(diff ? 'diff' : 'content')
  const [data, setData] = useState<FileData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.fileContent(path)
      setData({ content: res.content, size: res.size, truncated: res.truncated, binary: res.binary })
      setError(null)
    } catch (e) {
      setData(null)
      setError(e instanceof Error ? e.message : '文件读取失败')
    }
  }, [path])

  useEffect(() => {
    setTab(diff ? 'diff' : 'content')
    load().catch(() => undefined)
  }, [load, diff])

  useEffect(() => {
    const onTurn = () => { load().catch(() => undefined) }
    window.addEventListener('botcf:turn-complete', onTurn)
    return () => window.removeEventListener('botcf:turn-complete', onTurn)
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tabButton = (key: 'content' | 'diff', label: string) => (
    <button
      onClick={() => setTab(key)}
      style={{ fontSize: 12, padding: '2px 10px', borderRadius: 4, border: '1px solid #ccc', background: tab === key ? '#e8f0fe' : '#fff', fontWeight: tab === key ? 600 : 400, cursor: 'pointer' }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(760px, 78vw)', background: '#fff', borderLeft: '1px solid #ccc', boxShadow: '-4px 0 16px rgba(0,0,0,0.12)', zIndex: 40, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid #eee' }}>
        <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={path}>
          {path}
        </span>
        {tabButton('content', '内容')}
        {diff && tabButton('diff', '差异')}
        <button onClick={onClose} aria-label="关闭" style={{ fontSize: 14, padding: '2px 10px', border: 'none', background: 'transparent', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ fontSize: 11, color: '#888', padding: '4px 12px', borderBottom: '1px solid #f3f3f3' }}>
        {data ? formatSize(data.size) : ''}
        {data?.truncated ? ' · 文件过大,仅显示前 1 MB' : ''}
        {tab === 'diff' ? ' · 本会话 OMP 变更差异' : ''}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 8 }}>
        {tab === 'diff' && diff && <DiffView diff={diff} />}
        {tab === 'content' && error && <div style={{ fontSize: 12, color: '#c00' }}>{error}</div>}
        {tab === 'content' && data?.binary && <div style={{ fontSize: 12, color: '#888' }}>二进制文件,无法预览。</div>}
        {tab === 'content' && data && !data.binary && (
          <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.5, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'pre', color: '#24292f' }}>
            {data.content}
          </pre>
        )}
        {tab === 'content' && !data && !error && <div style={{ fontSize: 12, color: '#888' }}>加载中…</div>}
      </div>
    </div>
  )
}
