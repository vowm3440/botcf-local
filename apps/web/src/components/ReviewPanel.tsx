import { useCallback, useEffect, useMemo, useState } from 'react'
import DiffView from './DiffView'
import { BUTTON, DANGER_BUTTON, EMPTY_HINT, INPUT, MONO, PANEL_BODY, PRIMARY_BUTTON, ROW, SCROLL_AREA, STATUS_LINE, TOOLBAR, formatAge } from './ui'
import { requestOpenFile } from '../editor/openFile'
import { reviewApi, type ReviewItem, type ReviewOverview } from '../services/review'

/** AI-change review.
 *
 *  Every file the agent touched, with git's live view of it and one decision to
 *  make: keep it (接受, which also stages it so the later commit contains exactly
 *  what was reviewed) or throw it away (撤销, restored from git — deleting a newly
 *  created file needs the explicit checkbox, because git cannot bring it back).
 *  Reviewed files are then committed together with a message drawn from the
 *  project's template.
 *
 *  A file edited again after a decision returns to 待审查 on the server side: a
 *  stale approval would be worse than none. Directories that are not git
 *  repositories still show the agent's own diff, and the panel says plainly that
 *  automatic revert is unavailable there. */

const DECISION_STYLE: Record<ReviewItem['decision'], { label: string; color: string; background: string }> = {
  pending: { label: '待审查', color: '#9a6700', background: '#fffbe6' },
  accepted: { label: '已接受', color: '#1a7f37', background: '#f2fbf2' },
  reverted: { label: '已撤销', color: '#6e7781', background: '#f6f8fa' }
}

function gitLabel(item: ReviewItem): string {
  if (item.outsideWorkspace) return '工作区外'
  if (!item.git) return item.settled ? '与 git 一致' : '无 git 信息'
  const parts: string[] = []
  if (item.git.untracked) parts.push('新文件')
  if (item.git.staged) parts.push('已暂存')
  if (item.git.unstaged) parts.push('未暂存')
  return parts.join(' · ') || item.git.state
}

export default function ReviewPanel() {
  const [overview, setOverview] = useState<ReviewOverview | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>('')
  const [diffSource, setDiffSource] = useState<'git' | 'agent' | null>(null)
  const [deleteNew, setDeleteNew] = useState(false)
  const [message, setMessage] = useState('')
  const [commitRoot, setCommitRoot] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await reviewApi.overview()
      setOverview(next)
      setCommitRoot((prev) => prev || next.roots[0]?.id || '')
      return next
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '审查列表读取失败')
      return null
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => undefined)
  }, [refresh])

  // The agent finishing a turn is exactly when new changes appear.
  useEffect(() => {
    const onTurn = (): void => { refresh().catch(() => undefined) }
    window.addEventListener('botcf:turn-complete', onTurn)
    return () => window.removeEventListener('botcf:turn-complete', onTurn)
  }, [refresh])

  const openDiff = useCallback(async (path: string) => {
    setSelected(path)
    try {
      const result = await reviewApi.diff(path)
      setDiff(result.diff)
      setDiffSource(result.source)
      setNotice(result.truncated ? '差异较大,已截断显示' : null)
    } catch (error) {
      setDiff('')
      setDiffSource(null)
      setNotice(error instanceof Error ? error.message : '差异读取失败')
    }
  }, [])

  const act = async (label: string, action: () => Promise<{ notes?: string[] }>): Promise<void> => {
    setBusy(true)
    try {
      const result = await action()
      const next = await refresh()
      const notes = result.notes ?? []
      setNotice(notes.length > 0 ? notes.join(' / ') : `${label}完成`)
      if (selected && !next?.items.some((item) => item.path === selected)) {
        setSelected(null)
        setDiff('')
      } else if (selected) {
        await openDiff(selected)
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${label}失败`)
    } finally {
      setBusy(false)
    }
  }

  const items = overview?.items ?? []
  const pending = useMemo(() => items.filter((item) => item.decision === 'pending').map((item) => item.path), [items])
  const accepted = useMemo(() => items.filter((item) => item.decision === 'accepted').map((item) => item.path), [items])
  const activeRoot = overview?.roots.find((root) => root.id === commitRoot) ?? overview?.roots[0] ?? null
  const commitMessage = message || activeRoot?.commitMessage || ''

  return (
    <div style={PANEL_BODY}>
      <div style={TOOLBAR}>
        <button style={BUTTON} disabled={busy} onClick={() => { refresh().catch(() => undefined) }}>
          刷新
        </button>
        <button
          style={PRIMARY_BUTTON}
          disabled={busy || pending.length === 0}
          title="把所有待审查文件标记为保留(并按项目配置暂存)"
          onClick={() => { act('接受全部', () => reviewApi.accept(pending)).catch(() => undefined) }}
        >
          接受全部 ({pending.length})
        </button>
        <button
          style={DANGER_BUTTON}
          disabled={busy || pending.length === 0}
          title="用 git 还原所有待审查文件的改动"
          onClick={() => {
            if (!window.confirm(`撤销 ${pending.length} 个待审查文件的 AI 修改?`)) return
            act('撤销全部', () => reviewApi.revert(pending, deleteNew)).catch(() => undefined)
          }}
        >
          撤销全部
        </button>
        <span style={{ flex: 1 }} />
        <button
          style={BUTTON}
          disabled={busy || items.length === 0}
          title="只清空这个列表,不改动任何文件"
          onClick={() => { act('清空列表', () => reviewApi.clear().then(() => ({}))).catch(() => undefined) }}
        >
          清空列表
        </button>
      </div>

      <div style={{ ...STATUS_LINE, color: notice ? '#9a6700' : '#666' }} title={notice ?? ''}>
        {notice ??
          (overview
            ? `共 ${overview.summary.total} 个文件 · 待审查 ${overview.summary.pending} · 已接受 ${overview.summary.accepted} · 已撤销 ${overview.summary.reverted}${overview.summary.failed > 0 ? ` · 失败 ${overview.summary.failed}` : ''}`
            : '读取审查列表…')}
      </div>

      {items.length === 0 ? (
        <div style={EMPTY_HINT}>
          还没有 AI 修改需要审查。AI 每轮改完文件后,这里会列出改动的文件,
          可以逐个查看差异,再决定接受(暂存)还是撤销(用 git 还原)。
        </div>
      ) : (
        <>
          <div style={{ ...SCROLL_AREA, maxHeight: '45%' }}>
            {items.map((item) => {
              const decision = DECISION_STYLE[item.decision]
              return (
                <div
                  key={item.path}
                  style={{
                    ...ROW,
                    background: selected === item.path ? '#eaf3ff' : item.isError ? '#fff5f5' : undefined
                  }}
                >
                  <span style={{ flex: 'none', fontSize: 10, padding: '0 4px', borderRadius: 3, color: decision.color, background: decision.background, border: `1px solid ${decision.color}22` }}>
                    {decision.label}
                  </span>
                  <button
                    onClick={() => { openDiff(item.path).catch(() => undefined) }}
                    title={`${item.tools.join(', ')} · 第 ${item.turn} 轮 · ${gitLabel(item)}`}
                    style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: MONO, fontSize: 12, color: item.isError ? '#c00' : '#24292f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {item.path}
                  </button>
                  <span style={{ flex: 'none', fontSize: 10, color: '#8c959f' }}>{gitLabel(item)}</span>
                  <span style={{ flex: 'none', fontSize: 10, color: '#8c959f' }}>{formatAge(item.lastAt)}</span>
                  <button
                    style={BUTTON}
                    disabled={item.outsideWorkspace}
                    title={item.outsideWorkspace ? '这个文件在工作区之外,编辑器读不到' : '在编辑器中打开'}
                    onClick={() => requestOpenFile({ path: item.path })}
                  >
                    打开
                  </button>
                  <button
                    style={BUTTON}
                    disabled={busy || item.decision === 'accepted'}
                    onClick={() => { act('接受', () => reviewApi.accept([item.path])).catch(() => undefined) }}
                  >
                    接受
                  </button>
                  <button
                    style={DANGER_BUTTON}
                    disabled={busy || item.outsideWorkspace}
                    title={item.outsideWorkspace ? '工作区外的文件无法自动撤销' : '用 git 还原这个文件'}
                    onClick={() => {
                      if (!window.confirm(`撤销 ${item.path} 的 AI 修改?`)) return
                      act('撤销', () => reviewApi.revert([item.path], deleteNew)).catch(() => undefined)
                    }}
                  >
                    撤销
                  </button>
                </div>
              )
            })}
          </div>

          <div style={{ ...TOOLBAR, borderTop: '1px solid #eee' }}>
            <label style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={deleteNew} onChange={(event) => setDeleteNew(event.target.checked)} />
              撤销时删除 AI 新建的文件
            </label>
            {overview && overview.roots.length > 1 && (
              <select
                aria-label="提交目录"
                value={commitRoot}
                onChange={(event) => {
                  setCommitRoot(event.target.value)
                  setMessage('')
                }}
                style={{ fontSize: 12, maxWidth: 140 }}
              >
                {overview.roots.map((root) => (
                  <option key={root.id} value={root.id}>
                    {root.name} ({root.count})
                  </option>
                ))}
              </select>
            )}
            <input
              value={commitMessage}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="提交信息"
              aria-label="提交信息"
              disabled={busy || accepted.length === 0}
              style={{ ...INPUT, flex: 1, minWidth: 120 }}
            />
            <button
              style={PRIMARY_BUTTON}
              disabled={busy || accepted.length === 0 || activeRoot?.repository !== true}
              title={activeRoot?.repository ? '把已接受的文件提交到 git' : '该目录不是 git 仓库,无法提交'}
              onClick={() => {
                act('提交', () =>
                  reviewApi.commit({
                    ...(commitRoot ? { root: commitRoot } : {}),
                    ...(commitMessage ? { message: commitMessage } : {})
                  })
                )
                  .then(() => setMessage(''))
                  .catch(() => undefined)
              }}
            >
              提交已接受 ({accepted.length})
            </button>
          </div>

          {overview?.roots.some((root) => !root.repository) && (
            <div style={{ padding: '4px 8px', fontSize: 11, color: '#9a6700', background: '#fffbe6', borderTop: '1px solid #ffe58f' }}>
              {overview.roots
                .filter((root) => !root.repository)
                .map((root) => (
                  <div key={root.id}>
                    {root.name}:{root.installed ? '不是 git 仓库,只能查看差异,无法自动撤销或提交' : '本机没有安装 git'}
                  </div>
                ))}
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid #ddd' }}>
            <div style={{ ...STATUS_LINE, background: '#f6f8fa' }}>
              {selected
                ? `${selected} · 差异来自 ${diffSource === 'git' ? 'git(相对 HEAD)' : diffSource === 'agent' ? 'AI 工具输出' : '未知'}`
                : '点击文件名查看差异'}
            </div>
            <div style={{ ...SCROLL_AREA, padding: 8 }}>
              {selected && diff ? <DiffView diff={diff} /> : <div style={EMPTY_HINT}>选择上方文件即可逐行查看 AI 的修改。</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
