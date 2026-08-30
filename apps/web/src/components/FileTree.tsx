import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ChangedFileInfo, FileEntry, WorkspaceMutation, WorkspaceRootInfo } from '../api'
import WorkspaceBar from './WorkspaceBar'
import { notifyWorkspaceChanged, onWorkspaceChanged } from '../workspace/events'
import { isUnderWorkspacePath } from '../workspace/paths'
import { workspaceStatus } from '../workspace/status'
import { useAutoReveal } from '../workspace/useAutoReveal'
import { buildDiffCounts, type DiffCounts } from '../editor/editRegions'
import { diffColor } from '../editor/diffPalette'

interface FileTreeProps {
  /** Cumulative per-session changed files, keyed by qualified workspace path. */
  changed: Map<string, ChangedFileInfo>
  /** Open a file (qualified workspace path) in the editor drawer. */
  onOpenFile: (path: string) => void
  /** The file the editor has in front, highlighted here and — with 跟随 on —
   *  revealed by expanding its directories and scrolling to it. */
  activePath?: string | null
}

interface DirState {
  entries: FileEntry[]
  truncated: boolean
}

const AUTO_REVEAL_KEY = 'botcf.explorer.autoReveal'

/** The local API is a process the desktop shell starts alongside the window, so the
 *  first listing can land in a window where it is not answering yet — reloading right
 *  after a primary-root switch is exactly that window. Backing off a few times is the
 *  difference between "still loading" and a panel claiming the workspace is empty. */
const ROOT_RETRY_DELAYS = [200, 500, 1200] as const

/** Default on, like VS Code's `explorer.autoReveal`: with the agent opening a tab per
 *  file it edits, a tree that does not follow shows the wrong part of the project for
 *  most of a session. */
function loadAutoReveal(): boolean {
  try {
    return localStorage.getItem(AUTO_REVEAL_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Lazy workspace browser: the roots are the top level and only expanded
 *  directories are fetched, refreshed on every finished turn via the
 *  botcf:turn-complete window event. Every path here is a qualified workspace
 *  path (`<rootName>/<relative>`), which is also what the file APIs accept, so a
 *  single string identifies a file across all open roots. */
export default function FileTree({ changed, onOpenFile, activePath = null }: FileTreeProps) {
  const [roots, setRoots] = useState<WorkspaceRootInfo[]>([])
  const [maxRoots, setMaxRoots] = useState(8)
  /** False until a listing has actually come back. An unanswered request is not an
   *  empty workspace, and rendering it as one is how a reload right after a primary
   *  switch flashed 「0/8 个目录」 over a workspace that had roots. */
  const [loaded, setLoaded] = useState(false)
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; failed?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [autoReveal, setAutoReveal] = useState(loadAutoReveal)
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs
  const treeRef = useRef<HTMLDivElement | null>(null)

  /** Resolves false when the listing failed. `quiet` keeps a failure off screen
   *  while the first request is still being retried. */
  const loadDir = useCallback(async (workspacePath: string, options?: { quiet?: boolean }): Promise<boolean> => {
    try {
      const res = await api.files(workspacePath)
      setRoots(res.roots)
      setMaxRoots(res.maxRoots)
      setDirs((prev) => ({ ...prev, [workspacePath]: { entries: res.entries, truncated: res.truncated } }))
      setError(null)
      setLoaded(true)
      return true
    } catch (e) {
      // A directory that vanished (deleted on disk, or its root just left the
      // workspace) simply collapses; only the root listing itself is worth an
      // error banner, since without it the panel has nothing to show.
      if (workspacePath === '') {
        if (!options?.quiet) setError(e instanceof Error ? e.message : '文件列表加载失败')
        return false
      }
      setDirs((prev) => {
        if (!(workspacePath in prev)) return prev
        const next = { ...prev }
        delete next[workspacePath]
        return next
      })
      return false
    }
  }, [])

  const refreshAll = useCallback(() => {
    const expanded = Object.keys(dirsRef.current)
    for (const workspacePath of expanded.length > 0 ? expanded : ['']) {
      loadDir(workspacePath).catch(() => undefined)
    }
  }, [loadDir])

  useEffect(() => {
    let cancelled = false
    let timer = 0
    const attempt = (round: number): void => {
      const last = round >= ROOT_RETRY_DELAYS.length
      loadDir('', { quiet: !last })
        .then((ok) => {
          if (cancelled || ok || last) return
          timer = window.setTimeout(() => attempt(round + 1), ROOT_RETRY_DELAYS[round])
        })
        .catch(() => undefined)
    }
    attempt(0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [loadDir])

  useEffect(() => {
    window.addEventListener('botcf:turn-complete', refreshAll)
    return () => window.removeEventListener('botcf:turn-complete', refreshAll)
  }, [refreshAll])

  // The top bar can also change the workspace (选择主目录), so re-read on any
  // workspace mutation, wherever it came from.
  useEffect(() => onWorkspaceChanged(refreshAll), [refreshAll])

  const expandedDirs = useMemo(() => Object.keys(dirs), [dirs])
  const { reveal } = useAutoReveal({
    activePath,
    enabled: autoReveal,
    expanded: expandedDirs,
    expand: loadDir,
    containerRef: treeRef
  })

  const toggleAutoReveal = () => {
    setAutoReveal((previous) => {
      const next = !previous
      try {
        localStorage.setItem(AUTO_REVEAL_KEY, next ? 'on' : 'off')
      } catch {
        // Storage unavailable — the switch still holds for this session.
      }
      return next
    })
  }

  /** Added/removed line counts per changed file, for the badges. Derived from the
   *  same diffs the editor tracks, so the two never disagree. */
  const counts = useMemo(() => buildDiffCounts(changed.values()), [changed])

  /** Run a workspace mutation and rebuild the tree: root names are path
   *  prefixes, so anything already expanded may now mean something else.
   *  Returns whether the mutation succeeded, for callers with a form to close. */
  const mutate = async (action: () => Promise<WorkspaceMutation>, describe: (result: WorkspaceMutation) => string): Promise<boolean> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await action()
      setRoots(result.roots)
      setMaxRoots(result.maxRoots)
      setDirs({})
      // A cwd change that could not bring the agent back on the active route is a
      // half-done switch, and saying nothing about it is how a 409 later looks like
      // the model's own answer.
      setNotice(
        result.runtimeError
          ? { text: `${describe(result)},但 OMP 未能按新工作目录恢复:${result.runtimeError}`, failed: true }
          : { text: result.restarted ? `${describe(result)} · OMP 已按新工作目录重启` : describe(result) }
      )
      await loadDir('')
      notifyWorkspaceChanged()
      return true
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : '工作区更新失败', failed: true })
      return false
    } finally {
      setBusy(false)
    }
  }

  const toggleDir = (workspacePath: string) => {
    if (dirs[workspacePath]) {
      setDirs((prev) => {
        const next = { ...prev }
        for (const key of Object.keys(next)) {
          if (key === workspacePath || key.startsWith(`${workspacePath}/`)) delete next[key]
        }
        return next
      })
    } else {
      loadDir(workspacePath).catch(() => undefined)
    }
  }

  const hasChangeUnder = (workspacePath: string): boolean => {
    for (const changedPath of changed.keys()) {
      if (isUnderWorkspacePath(changedPath, workspacePath)) return true
    }
    return false
  }

  /** Top-level row for one root: it doubles as a directory node and carries the
   *  workspace actions for that project. */
  const renderRoot = (root: WorkspaceRootInfo) => {
    const opened = Boolean(dirs[root.name])
    return (
      <div key={root.id}>
        <div data-path={root.name} style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 0' }}>
          <span
            onClick={() => root.exists && toggleDir(root.name)}
            title={root.exists ? root.path : `${root.path}(目录不存在)`}
            style={{ flex: 1, minWidth: 0, cursor: root.exists ? 'pointer' : 'default', fontSize: 12, fontWeight: 600, color: root.exists ? '#24292f' : '#c00', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {root.exists ? (opened ? '▾' : '▸') : '⚠'} {root.name}
            {root.primary && <span title="AI 的工作目录(cwd)" style={{ marginLeft: 4, fontSize: 10, fontWeight: 400, color: '#0a6', border: '1px solid #b7e2c8', borderRadius: 3, padding: '0 3px' }}>主</span>}
            {!opened && hasChangeUnder(root.name) && <span style={{ color: '#2a7d46', marginLeft: 4 }}>●</span>}
          </span>
          {!root.primary && root.exists && (
            <button
              onClick={() => { mutate(() => api.setPrimaryRoot(root.id), () => `已切换主目录到 ${root.name}`).catch(() => undefined) }}
              disabled={busy}
              title="设为 AI 的工作目录(会重启 OMP 进程并停止预览)"
              style={{ fontSize: 10, padding: '0 4px', border: '1px solid #ccc', borderRadius: 3, background: '#fff', cursor: 'pointer' }}
            >
              设为主
            </button>
          )}
          <button
            onClick={() => { mutate(() => api.removeWorkspaceRoot(root.id), () => `已从工作区移除 ${root.name}`).catch(() => undefined) }}
            disabled={busy}
            aria-label={`从工作区移除 ${root.name}`}
            title="从工作区移除(不会删除磁盘上的文件)"
            style={{ fontSize: 10, padding: '0 4px', border: 'none', background: 'transparent', color: '#868e96', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
        {opened && renderEntries(root.name, 1)}
      </div>
    )
  }

  const renderEntries = (workspacePath: string, depth: number) => {
    const state = dirs[workspacePath]
    if (!state) return null
    return (
      <div>
        {state.entries.map((entry) => {
          const childPath = workspacePath ? `${workspacePath}/${entry.name}` : entry.name
          if (entry.type === 'dir') {
            const opened = Boolean(dirs[childPath])
            return (
              <div key={childPath}>
                <div
                  data-path={childPath}
                  onClick={() => toggleDir(childPath)}
                  style={{ cursor: 'pointer', padding: '2px 4px', paddingLeft: 4 + depth * 14, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {opened ? '▾' : '▸'} {entry.name}
                  {!opened && hasChangeUnder(childPath) && <span style={{ color: '#2a7d46', marginLeft: 4 }}>●</span>}
                </div>
                {opened && renderEntries(childPath, depth + 1)}
              </div>
            )
          }
          const change = changed.get(childPath)
          const count = counts.get(childPath)
          const isActive = childPath === activePath
          return (
            <div
              key={childPath}
              data-path={childPath}
              data-active={isActive ? 'true' : 'false'}
              onClick={() => onOpenFile(childPath)}
              title={
                change
                  ? `本会话已修改 · ${change.tools.join(', ')}${count ? ` · +${count.added} −${count.removed}` : ''} · 点击查看`
                  : `点击查看 ${entry.name}`
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                cursor: 'pointer',
                padding: '2px 4px',
                paddingLeft: 18 + depth * 14,
                fontSize: 12,
                color: change ? (change.isError ? '#c00' : '#2a7d46') : '#444',
                background: isActive ? 'rgba(0, 122, 255, 0.1)' : 'transparent',
                borderRadius: isActive ? 3 : 0,
                fontWeight: isActive ? 600 : 400
              }}
            >
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.name}
                {change && <span style={{ marginLeft: 4 }}>●</span>}
              </span>
              {count && <ChangeCount count={count} />}
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
  /** One value for 「还在读」/「读不到」/「读到了」, so the header and the body below
   *  cannot end up telling the user two different stories about the same request. */
  const status = workspaceStatus({ loaded, failed: error !== null })

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 8, boxSizing: 'border-box', background: '#fcfcfc', overflow: 'hidden' }}>
      <WorkspaceBar
        rootCount={roots.length}
        maxRoots={maxRoots}
        status={status}
        busy={busy}
        onRefresh={refreshAll}
        onAdd={(dir) =>
          mutate(
            () => api.addWorkspaceRoot({ path: dir }),
            (result) => (result.added ? `已添加目录 ${result.root?.name ?? ''}` : '该目录已在工作区中')
          )
        }
        autoReveal={autoReveal}
        onToggleAutoReveal={toggleAutoReveal}
        onReveal={reveal}
        canReveal={Boolean(activePath)}
      />
      {notice && <div style={{ fontSize: 11, color: notice.failed ? '#c00' : '#0a6', marginBottom: 6 }}>{notice.text}</div>}
      {changedList.length > 0 && (
        <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #eee' }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>本会话变更 ({changedList.length})</div>
          {changedList.map((file) => {
            const count = counts.get(file.path)
            return (
              <div
                key={file.path}
                onClick={() => onOpenFile(file.path)}
                title={`${file.tools.join(', ')}${count ? ` · +${count.added} −${count.removed}` : ''} · 点击查看差异`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  cursor: 'pointer',
                  color: file.isError ? '#c00' : '#2a7d46',
                  background: file.path === activePath ? 'rgba(0, 122, 255, 0.1)' : 'transparent',
                  borderRadius: file.path === activePath ? 3 : 0,
                  padding: '1px 2px'
                }}
              >
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {file.path}
                </span>
                {count && <ChangeCount count={count} />}
              </div>
            )
          })}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: '#c00', marginBottom: 8 }}>{error}</div>}
      {status === 'loading' && <div style={{ fontSize: 12, color: '#888' }}>正在读取工作区…</div>}
      {status === 'ready' && roots.length === 0 && !error && (
        <div style={{ fontSize: 12, color: '#888' }}>工作区还没有目录。用上方「添加目录」加入项目目录后,这里会显示文件列表;第一个目录会成为 AI 的工作目录。</div>
      )}
      <div ref={treeRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>{roots.map(renderRoot)}</div>
    </div>
  )
}

/** `+N −M` for one file. Monospace and fixed-order so a column of them reads as a
 *  column rather than as text that happens to contain numbers. */
function ChangeCount({ count }: { count: DiffCounts }) {
  return (
    <span aria-hidden style={{ flex: 'none', fontFamily: 'monospace', fontSize: 10, letterSpacing: -0.2 }}>
      <span style={{ color: diffColor.addInk }}>+{count.added}</span>{' '}
      <span style={{ color: diffColor.delInk }}>−{count.removed}</span>
    </span>
  )
}
