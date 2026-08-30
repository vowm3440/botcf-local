import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DiffView from './DiffView'
import RootPicker from './RootPicker'
import { BUTTON, DANGER_BUTTON, EMPTY_HINT, INPUT, MONO, PANEL_BODY, PRIMARY_BUTTON, ROW, SCROLL_AREA, STATUS_LINE, TOOLBAR, formatAge } from './ui'
import { requestOpenFile } from '../editor/openFile'
import { gitApi, type GitCommit, type GitDiffMode, type GitStatusEntry, type GitStatusResponse } from '../services/git'
import { onWorkspaceChanged } from '../workspace/events'
import { joinWorkspacePath } from '../workspace/paths'

/** Git panel: state, diff, staging, commit and the two kinds of rollback.
 *
 *  It works on one workspace root at a time (the picker chooses which), and speaks
 *  git's own root-relative paths — turning them into qualified workspace paths only
 *  when handing a file to the editor.
 *
 *  The two rollbacks are deliberately distinct, because they are not
 *  interchangeable: 「撤销修改」throws away uncommitted work for the selected
 *  files, while 「撤销上一个提交」/「回滚此提交」act on history — the former moves the
 *  branch back keeping changes, the latter records an inverse commit, which is the
 *  safe choice once a commit is pushed. */

const STATE_LABELS: Record<GitStatusEntry['state'], string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  'type-changed': '类型变化',
  untracked: '未跟踪',
  ignored: '已忽略',
  conflicted: '冲突'
}

const STATE_COLORS: Record<GitStatusEntry['state'], string> = {
  modified: '#0969da',
  added: '#1a7f37',
  deleted: '#cf222e',
  renamed: '#8250df',
  copied: '#8250df',
  'type-changed': '#9a6700',
  untracked: '#6e7781',
  ignored: '#8c959f',
  conflicted: '#cf222e'
}

interface Group {
  key: string
  title: string
  entries: GitStatusEntry[]
}

function groupEntries(entries: readonly GitStatusEntry[]): Group[] {
  const conflicted = entries.filter((entry) => entry.conflicted)
  const staged = entries.filter((entry) => entry.staged && !entry.conflicted)
  const changed = entries.filter((entry) => entry.unstaged && !entry.untracked && !entry.conflicted)
  const untracked = entries.filter((entry) => entry.untracked)
  return [
    { key: 'conflicted', title: `冲突 (${conflicted.length})`, entries: conflicted },
    { key: 'staged', title: `已暂存 (${staged.length})`, entries: staged },
    { key: 'changed', title: `未暂存 (${changed.length})`, entries: changed },
    { key: 'untracked', title: `未跟踪 (${untracked.length})`, entries: untracked }
  ].filter((group) => group.entries.length > 0)
}

function branchLine(status: GitStatusResponse): string {
  const { branch, info } = status
  if (!info.installed) return '本机没有安装 git'
  if (!info.repository) return '该目录不是 git 仓库'
  const parts: string[] = []
  parts.push(branch.detached ? 'HEAD (游离)' : branch.branch ?? '(未知分支)')
  if (branch.unborn) parts.push('尚无提交')
  if (branch.upstream) parts.push(`↔ ${branch.upstream}`)
  if (branch.ahead > 0) parts.push(`↑${branch.ahead}`)
  if (branch.behind > 0) parts.push(`↓${branch.behind}`)
  parts.push(`暂存 ${status.stagedCount} · 未暂存 ${status.unstagedCount} · 未跟踪 ${status.untrackedCount}`)
  if (status.head) parts.push(`HEAD ${status.head.shortHash} ${status.head.subject}`)
  return parts.join(' · ')
}

export default function GitPanel() {
  const [rootId, setRootId] = useState('')
  const [status, setStatus] = useState<GitStatusResponse | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diffMode, setDiffMode] = useState<GitDiffMode>('worktree')
  const [diff, setDiff] = useState<string>('')
  const [message, setMessage] = useState('')
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [deleteNew, setDeleteNew] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** Current root for the stable callbacks below, which must not be re-created on
   *  every selection change (they are wired to window events). */
  const rootRef = useRef('')

  const refresh = useCallback(async (root?: string) => {
    try {
      const next = await gitApi.status(root ?? rootRef.current)
      setStatus(next)
      rootRef.current = next.root.id
      setRootId(next.root.id)
      setNotice(null)
      return next
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'git 状态读取失败')
      return null
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => undefined)
  }, [refresh])

  // A finished agent turn changes the working tree; so does adding/removing roots.
  useEffect(() => {
    const onTurn = (): void => { refresh().catch(() => undefined) }
    window.addEventListener('botcf:turn-complete', onTurn)
    return () => window.removeEventListener('botcf:turn-complete', onTurn)
  }, [refresh])
  useEffect(() => onWorkspaceChanged(() => { refresh().catch(() => undefined) }), [refresh])

  const loadDiff = useCallback(async (path: string, mode: GitDiffMode) => {
    try {
      const result = await gitApi.diff({ root: rootRef.current, path, mode })
      setDiff(result.diff || '(没有差异)')
      setNotice(result.truncated ? '差异较大,已截断显示' : null)
    } catch (error) {
      setDiff('')
      setNotice(error instanceof Error ? error.message : '差异读取失败')
    }
  }, [])

  const select = (entry: GitStatusEntry): void => {
    // Show the side that actually has content: a file with only staged changes
    // has an empty working-tree diff, which would look like "nothing happened".
    const mode: GitDiffMode = entry.untracked ? 'head' : entry.unstaged ? 'worktree' : 'staged'
    setSelected(entry.path)
    setDiffMode(mode)
    loadDiff(entry.path, mode).catch(() => undefined)
  }

  const act = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      const next = await refresh()
      if (selected && next?.entries.some((entry) => entry.path === selected)) {
        await loadDiff(selected, diffMode)
      } else if (selected) {
        setDiff('')
        setSelected(null)
      }
      setNotice(`${label}完成`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${label}失败`)
    } finally {
      setBusy(false)
    }
  }

  const loadHistory = useCallback(async () => {
    try {
      const result = await gitApi.log({ root: rootRef.current, limit: 30 })
      setCommits(result.commits)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交历史读取失败')
    }
  }, [])

  useEffect(() => {
    if (showHistory) loadHistory().catch(() => undefined)
  }, [showHistory, loadHistory])

  const groups = useMemo(() => groupEntries(status?.entries ?? []), [status])
  const repository = status?.info.repository === true
  const rootName = status?.root.name ?? ''

  const commit = async (): Promise<void> => {
    const text = message.trim()
    if (!text) {
      setNotice('请先填写提交信息')
      return
    }
    await act('提交', async () => {
      const result = await gitApi.commit({ root: rootId, message: text })
      setMessage('')
      if (result.commit) setNotice(`已提交 ${result.commit.shortHash}`)
      if (showHistory) await loadHistory()
    })
  }

  return (
    <div style={PANEL_BODY}>
      <div style={TOOLBAR}>
        <RootPicker
          roots={status?.roots ?? []}
          value={rootId}
          disabled={busy}
          label="git 目录"
          onChange={(id) => {
            setRootId(id)
            setSelected(null)
            setDiff('')
            setCommits([])
            refresh(id).catch(() => undefined)
          }}
        />
        <button style={BUTTON} disabled={busy} onClick={() => { refresh().catch(() => undefined) }}>
          刷新
        </button>
        <button
          style={BUTTON}
          disabled={busy || !repository || (status?.entries.length ?? 0) === 0}
          onClick={() => { act('暂存全部', () => gitApi.stage({ root: rootId, paths: (status?.entries ?? []).map((entry) => entry.path) })).catch(() => undefined) }}
        >
          暂存全部
        </button>
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              commit().catch(() => undefined)
            }
          }}
          placeholder="提交信息…Enter 提交"
          aria-label="提交信息"
          disabled={busy || !repository}
          style={{ ...INPUT, flex: 1, minWidth: 120 }}
        />
        <button style={PRIMARY_BUTTON} disabled={busy || !repository || !message.trim()} onClick={() => { commit().catch(() => undefined) }}>
          提交
        </button>
        <button style={BUTTON} disabled={!repository} onClick={() => setShowHistory((prev) => !prev)}>
          {showHistory ? '隐藏历史' : '历史'}
        </button>
      </div>

      <div style={{ ...STATUS_LINE, color: status?.info.repository === false ? '#9a6700' : '#666' }} title={status ? branchLine(status) : ''}>
        {notice ?? (status ? branchLine(status) : '读取 git 状态…')}
      </div>

      {!repository && (
        <div style={EMPTY_HINT}>
          {status?.info.installed === false
            ? '本机没有找到 git 可执行文件。安装 git 后即可在这里查看状态、差异并提交。'
            : '这个目录还不是 git 仓库。在内置终端里执行 git init 后,状态、差异、提交与回滚都会在这里可用。'}
          {status?.info.error && <div style={{ color: '#c00', marginTop: 6 }}>{status.info.error}</div>}
        </div>
      )}

      {repository && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ ...SCROLL_AREA, maxHeight: '45%' }}>
            {groups.length === 0 && <div style={EMPTY_HINT}>工作区是干净的,没有未提交的改动。</div>}
            {groups.map((group) => (
              <div key={group.key}>
                <div style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, color: '#57606a', background: '#f6f8fa', borderBottom: '1px solid #eee' }}>
                  {group.title}
                </div>
                {group.entries.map((entry) => (
                  <div
                    key={`${group.key}:${entry.path}`}
                    style={{ ...ROW, background: selected === entry.path ? '#eaf3ff' : undefined }}
                  >
                    <span style={{ flex: 'none', width: 52, color: STATE_COLORS[entry.state], fontWeight: 600 }}>
                      {STATE_LABELS[entry.state]}
                    </span>
                    <button
                      onClick={() => select(entry)}
                      title={entry.from ? `原路径 ${entry.from}` : entry.path}
                      style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {entry.path}
                    </button>
                    <button
                      style={BUTTON}
                      title="在编辑器中打开"
                      disabled={entry.state === 'deleted'}
                      onClick={() => requestOpenFile({ path: joinWorkspacePath(rootName, entry.path) })}
                    >
                      打开
                    </button>
                    {entry.staged ? (
                      <button style={BUTTON} disabled={busy} onClick={() => { act('取消暂存', () => gitApi.unstage({ root: rootId, paths: [entry.path] })).catch(() => undefined) }}>
                        取消暂存
                      </button>
                    ) : (
                      <button style={BUTTON} disabled={busy} onClick={() => { act('暂存', () => gitApi.stage({ root: rootId, paths: [entry.path] })).catch(() => undefined) }}>
                        暂存
                      </button>
                    )}
                    <button
                      style={DANGER_BUTTON}
                      disabled={busy}
                      title={entry.untracked ? '删除这个新文件(不可恢复,需要勾选下方的删除新建文件)' : '丢弃这个文件的未提交修改'}
                      onClick={() => {
                        if (!window.confirm(`确定丢弃 ${entry.path} 的未提交修改?`)) return
                        act('撤销修改', () => gitApi.discard({ root: rootId, paths: [entry.path], deleteNew })).catch(() => undefined)
                      }}
                    >
                      撤销
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {status?.truncated && <div style={EMPTY_HINT}>改动文件过多,列表已截断显示。</div>}
          </div>

          <label style={{ ...ROW, borderTop: '1px solid #eee', color: '#666' }}>
            <input type="checkbox" checked={deleteNew} onChange={(event) => setDeleteNew(event.target.checked)} />
            撤销时删除新建文件(git 无法恢复被删除的新文件)
          </label>

          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid #eee' }}>
            <div style={{ ...TOOLBAR, borderBottom: '1px solid #f6f6f6' }}>
              <span style={{ fontSize: 12, fontFamily: MONO, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected ?? '选择一个文件查看差异'}
              </span>
              {(['worktree', 'staged', 'head'] as GitDiffMode[]).map((mode) => (
                <button
                  key={mode}
                  disabled={!selected}
                  onClick={() => {
                    setDiffMode(mode)
                    if (selected) loadDiff(selected, mode).catch(() => undefined)
                  }}
                  style={{ ...BUTTON, background: diffMode === mode ? '#eaf3ff' : '#fff', fontWeight: diffMode === mode ? 600 : 400 }}
                >
                  {mode === 'worktree' ? '未暂存' : mode === 'staged' ? '已暂存' : '相对 HEAD'}
                </button>
              ))}
            </div>
            <div style={{ ...SCROLL_AREA, padding: 8 }}>
              {selected && diff ? <DiffView diff={diff} /> : <div style={EMPTY_HINT}>点击上方文件名即可查看差异。</div>}
            </div>
          </div>

          {showHistory && (
            <div style={{ flex: 'none', maxHeight: 200, overflow: 'auto', borderTop: '1px solid #ddd', background: '#fbfcfd' }}>
              <div style={{ ...TOOLBAR, background: '#f6f8fa' }}>
                <span style={{ fontSize: 11, color: '#57606a', flex: 1 }}>提交历史</span>
                <button
                  style={BUTTON}
                  disabled={busy || !status?.head}
                  title="把分支指针回退一个提交,改动保留在工作区"
                  onClick={() => {
                    if (!window.confirm('撤销上一个提交?改动会保留在工作区(未暂存)。')) return
                    act('撤销上一个提交', () => gitApi.undo({ root: rootId, mode: 'mixed' })).then(loadHistory).catch(() => undefined)
                  }}
                >
                  撤销上一个提交
                </button>
              </div>
              {commits.length === 0 && <div style={EMPTY_HINT}>还没有提交。</div>}
              {commits.map((entry) => (
                <div key={entry.hash} style={ROW}>
                  <span style={{ fontFamily: MONO, color: '#8250df', flex: 'none' }}>{entry.shortHash}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${entry.subject}\n${entry.author} · ${new Date(entry.at).toLocaleString()}${entry.refs ? `\n${entry.refs}` : ''}`}>
                    {entry.subject}
                  </span>
                  <span style={{ flex: 'none', color: '#8c959f', fontSize: 11 }}>{formatAge(entry.at)}</span>
                  <button
                    style={BUTTON}
                    disabled={busy}
                    title="生成一个反向提交,撤销这次改动(不改写历史)"
                    onClick={() => {
                      if (!window.confirm(`回滚提交 ${entry.shortHash}?会生成一个反向提交。`)) return
                      act('回滚提交', () => gitApi.revert({ root: rootId, hash: entry.hash })).then(loadHistory).catch(() => undefined)
                    }}
                  >
                    回滚
                  </button>
                </div>
              ))}
              <div style={{ ...ROW, color: '#8c959f' }}>
                回滚产生冲突时,解决后继续,或
                <button style={BUTTON} disabled={busy} onClick={() => { act('放弃回滚', () => gitApi.revertAbort({ root: rootId })).catch(() => undefined) }}>
                  放弃回滚
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
