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

/** Read-only editor panel body: 内容 tab shows the file, 差异 tab shows the
 *  session's inline diff. Content refreshes after each finished turn. */
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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#fff', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid #f0f0f0' }}>
        {tabButton('content', '内容')}
        {diff && tabButton('diff', '差异')}
        <span style={{ flex: 1, textAlign: 'right', fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data ? formatSize(data.size) : ''}
          {data?.truncated ? ' · 仅显示前 1 MB' : ''}
          {tab === 'diff' ? ' · 本会话 OMP 变更' : ''}
        </span>
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
