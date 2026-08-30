import type { CSSProperties, ReactNode } from 'react'
import { diffColor } from './diffPalette'
import type { EditRegions } from './editRegions'
import { color, radius, text } from '../design/tokens'

/** The bar above one open file: which view, what to do with unsaved edits, and what
 *  the assistant changed here.
 *
 *  Three views of the same file, in the order you would reach for them: the buffer you
 *  type in, the same file with the changes shown in place, and the raw unified diff for
 *  when you want to read exactly what the tool reported. The last two only exist when
 *  there is a diff, so the strip does not grow buttons that lead nowhere.
 *
 *  The `+N −M` chip is the whole point of the AI-edit tracking made visible: it counts
 *  what is still *findable* in the file, so a region the next turn overwrote stops
 *  being claimed. When some of the diff can no longer be located the chip says so
 *  instead of quietly showing a smaller number. */

export type ViewMode = 'content' | 'inline' | 'diff'

export interface ViewerHeaderProps {
  mode: ViewMode
  onMode: (mode: ViewMode) => void
  /** False hides the two diff views: this file has no reported change. */
  hasDiff: boolean
  dirty: boolean
  editable: boolean
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  /** Anchored edits for the buffer on screen. */
  edits: EditRegions
  /** True when part of the reported diff is no longer in the file. */
  stale: boolean
  onPreviousRegion: () => void
  onNextRegion: () => void
  /** Right-hand meta line: size, encoding, save result. */
  meta: ReactNode
  metaAlert: boolean
}

const BUTTON: CSSProperties = {
  ...text.micro,
  padding: '2px 9px',
  border: `1px solid ${color.lineStrong}`,
  borderRadius: radius.r1,
  background: color.surface,
  color: color.ink2,
  cursor: 'pointer',
  flex: 'none'
}

const MODE_LABELS: ReadonlyArray<{ mode: ViewMode; label: string; title: string }> = [
  { mode: 'content', label: '内容', title: '可编辑的缓冲区,左边距标出 AI 改过的行' },
  { mode: 'inline', label: '内联', title: '整份文件里就地显示 AI 的改动,删除的行留在原位' },
  { mode: 'diff', label: '差异', title: 'OMP 工具报告的统一差异原文' }
]

export default function ViewerHeader({
  mode,
  onMode,
  hasDiff,
  dirty,
  editable,
  saving,
  onSave,
  onDiscard,
  edits,
  stale,
  onPreviousRegion,
  onNextRegion,
  meta,
  metaAlert
}: ViewerHeaderProps) {
  const modes = hasDiff ? MODE_LABELS : MODE_LABELS.slice(0, 1)
  const navigable = edits.regions.length > 0
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '5px 8px',
        flex: 'none',
        borderBottom: `1px solid ${color.line}`,
        background: color.surface
      }}
    >
      <div role="tablist" aria-label="文件视图" style={{ display: 'flex', gap: 4, flex: 'none' }}>
        {modes.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            role="tab"
            aria-selected={mode === entry.mode}
            onClick={() => onMode(entry.mode)}
            title={entry.title}
            style={{
              ...BUTTON,
              background: mode === entry.mode ? color.accentWash : color.surface,
              borderColor: mode === entry.mode ? color.accent : color.lineStrong,
              color: mode === entry.mode ? color.accent : color.ink2,
              fontWeight: mode === entry.mode ? 600 : 400
            }}
          >
            {entry.mode === 'content' && dirty ? `${entry.label} ●` : entry.label}
          </button>
        ))}
      </div>

      {mode === 'content' && editable && dirty && (
        <>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            title="保存到磁盘(Ctrl/Cmd+S)"
            style={{ ...BUTTON, borderColor: color.green, color: color.green, fontWeight: 600 }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button type="button" onClick={onDiscard} disabled={saving} title="放弃缓冲区里的修改,重新读取磁盘" style={BUTTON}>
            放弃修改
          </button>
        </>
      )}

      {hasDiff && (
        <span
          title={
            navigable
              ? `AI 在这个文件里改了 ${edits.regions.length} 处(+${edits.added} −${edits.removed})${stale ? ';另有部分改动已被后续修改覆盖,无法定位' : ''}${edits.approximate ? ';行号由差异推算,已按内容重新对齐' : ''}`
              : 'AI 报告过改动,但在当前内容里已找不到对应的行'
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            flex: 'none',
            ...text.micro,
            padding: '1px 7px',
            border: `1px solid ${color.line}`,
            borderRadius: radius.pill,
            background: color.sunken,
            color: color.ink2
          }}
        >
          <span>AI</span>
          {navigable ? (
            <>
              <span style={{ color: diffColor.addInk, fontWeight: 600 }}>+{edits.added}</span>
              <span style={{ color: diffColor.delInk, fontWeight: 600 }}>−{edits.removed}</span>
              <span style={{ color: color.ink3 }}>{edits.regions.length} 处</span>
            </>
          ) : (
            <span style={{ color: color.ink3 }}>已被覆盖</span>
          )}
          {stale && navigable && <span title="部分改动无法定位" style={{ color: color.amber }}>!</span>}
        </span>
      )}

      {navigable && (
        <span style={{ display: 'flex', gap: 2, flex: 'none' }}>
          <button type="button" onClick={onPreviousRegion} title="上一处 AI 改动(Shift+Alt+F5)" style={BUTTON}>
            ↑
          </button>
          <button type="button" onClick={onNextRegion} title="下一处 AI 改动(Alt+F5)" style={BUTTON}>
            ↓
          </button>
        </span>
      )}

      <span
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: 'right',
          ...text.micro,
          color: metaAlert ? color.red : color.ink3,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {meta}
      </span>
    </div>
  )
}
