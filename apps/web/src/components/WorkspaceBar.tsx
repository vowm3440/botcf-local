import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { WorkspaceStatus } from '../workspace/status'

/** File-panel header: how many project directories the workspace holds, the form
 *  that opens another one, and whether the tree follows the editor.
 *
 *  Adding a directory is deliberately cheap — it only widens what the file tree, the
 *  editor and the preview can reach, and never restarts the agent; that only happens
 *  when the *primary* root changes (see the 设为主 action on each root in the tree).
 *
 *  「跟随」 is the auto-reveal switch. It belongs here rather than in a menu because it
 *  changes what the panel does on its own — with the agent opening a tab per file it
 *  touches, a tree that silently expands is either exactly what you want or the most
 *  annoying thing on screen, and which one it is has to be one click away.
 *
 *  Presentational: the owner performs the mutation and reports success, so every
 *  workspace call in this panel goes through one place. */

export interface WorkspaceBarProps {
  rootCount: number
  maxRoots: number
  /** Loading / failed / ready for the workspace listing. An unanswered request is
   *  not an empty workspace and a listing that has given up is not still loading —
   *  the count may only speak for itself once the status says `ready`. */
  status: WorkspaceStatus
  busy: boolean
  onRefresh: () => void
  /** Resolves true once the directory was opened; false keeps the form up. */
  onAdd: (path: string) => Promise<boolean>
  /** Expand and scroll to the active editor file whenever it changes. */
  autoReveal: boolean
  onToggleAutoReveal: () => void
  /** Reveal the active file once, whatever the toggle says. */
  onReveal: () => void
  /** False when no file is open, which leaves nothing to reveal. */
  canReveal: boolean
}

/** Four small controls in a sidebar that can be dragged narrow: each keeps its own
 *  width and the row wraps rather than clipping a button off the edge. */
const BUTTON: CSSProperties = {
  flex: 'none',
  whiteSpace: 'nowrap',
  fontSize: 12,
  padding: '1px 8px',
  borderRadius: 4,
  border: '1px solid #ccc',
  background: '#fff',
  cursor: 'pointer'
}

/** The one line that says which of the three states the listing is in. A failed
 *  listing has to read as failed: 「读取中…」 over an error banner tells the user to
 *  keep waiting for something that already gave up, and 刷新 is right next to it. */
const SUMMARY: Record<WorkspaceStatus, { title: string; color: string }> = {
  loading: { title: '正在读取工作区目录…', color: '#999' },
  failed: { title: '工作区目录读取失败,点击「刷新」重试', color: '#c00' },
  ready: { title: '工作区中的项目目录数量', color: '#999' }
}

export default function WorkspaceBar({
  rootCount,
  maxRoots,
  status,
  busy,
  onRefresh,
  onAdd,
  autoReveal,
  onToggleAutoReveal,
  onReveal,
  canReveal
}: WorkspaceBarProps) {
  const [adding, setAdding] = useState(false)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)

  const full = status === 'ready' && rootCount >= maxRoots

  const submit = async () => {
    const dir = input.trim()
    if (!dir || pending) return
    setPending(true)
    try {
      if (await onAdd(dir)) {
        setInput('')
        setAdding(false)
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          title={SUMMARY[status].title}
          style={{ flex: '1 1 60px', minWidth: 0, fontSize: 11, color: SUMMARY[status].color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {status === 'loading' && '工作区 · 读取中…'}
          {status === 'failed' && '工作区 · 无法读取'}
          {status === 'ready' && `工作区 · ${rootCount}/${maxRoots} 个目录`}
        </span>
        <button
          onClick={onReveal}
          disabled={!canReveal}
          title={canReveal ? '在树中展开并定位当前编辑的文件' : '编辑器里还没有打开文件'}
          aria-label="定位当前文件"
          style={{ ...BUTTON, color: canReveal ? '#444' : '#bbb', cursor: canReveal ? 'pointer' : 'default' }}
        >
          定位
        </button>
        <button
          onClick={onToggleAutoReveal}
          aria-pressed={autoReveal}
          title={
            autoReveal
              ? '跟随:切换标签或 AI 改动文件时,自动展开并定位(点击关闭)'
              : '跟随已关闭:树不会自动展开(点击开启)'
          }
          style={{
            ...BUTTON,
            borderColor: autoReveal ? '#007aff' : '#ccc',
            background: autoReveal ? 'rgba(0, 122, 255, 0.1)' : '#fff',
            color: autoReveal ? '#007aff' : '#444',
            fontWeight: autoReveal ? 600 : 400
          }}
        >
          跟随
        </button>
        <button
          onClick={() => { setAdding((prev) => !prev); setInput('') }}
          disabled={busy || full}
          title={full ? `工作区最多 ${maxRoots} 个目录` : '把另一个项目目录加入工作区'}
          style={BUTTON}
        >
          {adding ? '取消' : '添加目录'}
        </button>
        <button onClick={onRefresh} disabled={busy} style={BUTTON}>刷新</button>
      </div>
      {adding && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <input
            value={input}
            autoFocus
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit().catch(() => undefined)
              if (event.key === 'Escape') setAdding(false)
            }}
            placeholder="项目目录完整路径,如 D:\\code\\myapp"
            spellCheck={false}
            aria-label="要加入工作区的目录路径"
            style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '2px 6px', border: '1px solid #ccc', borderRadius: 4 }}
          />
          <button onClick={() => { submit().catch(() => undefined) }} disabled={pending || !input.trim()} style={BUTTON}>
            {pending ? '添加中…' : '添加'}
          </button>
        </div>
      )}
    </div>
  )
}
