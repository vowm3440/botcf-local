import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ChangedFileInfo, FileEntry } from '../api'

interface FileTreeProps {
  /** Cumulative per-session changed files, keyed by workdir-relative path. */
  changed: Map<string, ChangedFileInfo>
  /** Open a file (workdir-relative path) in the editor drawer. */
  onOpenFile: (path: string) => void
}

interface DirState {
  entries: FileEntry[]
  truncated: boolean
}

/** Lazy workdir browser: only expanded directories are fetched, refreshed on
 *  every finished turn via the botcf:turn-complete window event. */
export default function FileTree({ changed, onOpenFile }: FileTreeProps) {
  const [workdir, setWorkdir] = useState<string | null>(null)
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [error, setError] = useState<string | null>(null)
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs

  const loadDir = useCallback(async (rel: string) => {
    try {
      const res = await api.files(rel)
      setWorkdir(res.workdir)
      if (res.workdir) {
        setDirs((prev) => ({ ...prev, [rel]: { entries: res.entries, truncated: res.truncated } }))
      } else {
        setDirs({})
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '文件列表加载失败')
    }
  }, [])

  const refreshAll = useCallback(() => {
    const expanded = Object.keys(dirsRef.current)
    for (const rel of expanded.length > 0 ? expanded : ['']) {
      loadDir(rel).catch(() => undefined)
    }
  }, [loadDir])

  useEffect(() => {
    loadDir('').catch(() => undefined)
  }, [loadDir])

  useEffect(() => {
    window.addEventListener('botcf:turn-complete', refreshAll)
    return () => window.removeEventListener('botcf:turn-complete', refreshAll)
  }, [refreshAll])

  const toggleDir = (rel: string) => {
    if (dirs[rel]) {
      setDirs((prev) => {
        const next = { ...prev }
        for (const key of Object.keys(next)) {
          if (key === rel || key.startsWith(`${rel}/`)) delete next[key]
        }
        return next
      })
    } else {
      loadDir(rel).catch(() => undefined)
    }
  }

  const hasChangeUnder = (rel: string): boolean => {
    for (const changedPath of changed.keys()) {
      if (changedPath === rel || changedPath.startsWith(`${rel}/`)) return true
    }
    return false
  }

  const renderEntries = (rel: string, depth: number) => {
    const state = dirs[rel]
    if (!state) return null
    return (
      <div>
        {state.entries.map((entry) => {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name
          if (entry.type === 'dir') {
            const opened = Boolean(dirs[childRel])
            return (
              <div key={childRel}>
                <div
                  onClick={() => toggleDir(childRel)}
                  style={{ cursor: 'pointer', padding: '2px 4px', paddingLeft: 4 + depth * 14, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {opened ? '▾' : '▸'} {entry.name}
                  {!opened && hasChangeUnder(childRel) && <span style={{ color: '#2a7d46', marginLeft: 4 }}>●</span>}
                </div>
                {opened && renderEntries(childRel, depth + 1)}
              </div>
            )
          }
          const change = changed.get(childRel)
          return (
            <div
              key={childRel}
              onClick={() => onOpenFile(childRel)}
              title={change ? `本会话已修改 · ${change.tools.join(', ')} · 点击查看` : `点击查看 ${entry.name}`}
              style={{ cursor: 'pointer', padding: '2px 4px', paddingLeft: 18 + depth * 14, fontSize: 12, color: change ? (change.isError ? '#c00' : '#2a7d46') : '#444', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {entry.name}
              {change && <span style={{ marginLeft: 4 }}>●</span>}
            </div>
          )
        })}
        {state.truncated && (
          <div style={{ paddingLeft: 4 + depth * 14, fontSize: 11, color: '#999' }}>(仅显示前 {state.entries.length} 项)</div>
        )}
      </div>
    )
  }

  const changedList = [...changed.values()]

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 8, boxSizing: 'border-box', background: '#fcfcfc', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span style={{ flex: 1, fontSize: 11, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={workdir ?? undefined}>
          {workdir ?? ''}
        </span>
        <button onClick={refreshAll} style={{ fontSize: 12 }}>刷新</button>
      </div>
      {changedList.length > 0 && (
        <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #eee' }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>本会话变更 ({changedList.length})</div>
          {changedList.map((file) => (
            <div
              key={file.path}
              onClick={() => onOpenFile(file.path)}
              title={`${file.tools.join(', ')} · 点击查看差异`}
              style={{ fontFamily: 'monospace', fontSize: 11, cursor: 'pointer', color: file.isError ? '#c00' : '#2a7d46', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '1px 0' }}
            >
              {file.path}
            </div>
          ))}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: '#c00', marginBottom: 8 }}>{error}</div>}
      {workdir === null && !error && (
        <div style={{ fontSize: 12, color: '#888' }}>未设置工作目录。在顶部 OMP 区域选择项目目录后,这里会显示文件列表。</div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>{renderEntries('', 0)}</div>
    </div>
  )
}
