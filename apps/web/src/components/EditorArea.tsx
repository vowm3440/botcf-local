import EditorTabs from './EditorTabs'
import { color, text } from '../design/tokens'
import type { OpenTabsApi } from '../editor/useOpenTabs'
import type { DiffCounts } from '../editor/editRegions'

/** The editor part: the open files, or the watermark that stands in for them.
 *
 *  The editor is a dock part like any other — it can be closed, stacked behind
 *  another tab or dragged to an edge — so its empty state has to stand on its own.
 *  It says where files come from and lists the shortcuts that are otherwise
 *  undiscoverable, because this is the largest empty surface in the workbench and
 *  the first thing a new user looks at. */

export interface EditorAreaProps {
  tabs: OpenTabsApi
  /** Session diff for a path, when the assistant changed it. */
  diffFor: (path: string) => string | undefined
  /** Added/removed line counts per path, for the tab strip. */
  counts?: ReadonlyMap<string, DiffCounts>
}

const SHORTCUTS: ReadonlyArray<{ keys: string; what: string }> = [
  { keys: 'Ctrl+Alt+←/→', what: '在标签之间切换' },
  { keys: 'Alt+1…9', what: '跳到第 n 个标签' },
  { keys: 'Alt+F5', what: '跳到下一处 AI 改动(加 Shift 往回)' },
  { keys: 'Alt+Shift+方向键', what: '把当前面板停靠到窗口的那一边' }
]

function Watermark() {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        background: color.surface,
        color: color.ink3,
        padding: 24,
        textAlign: 'center'
      }}
    >
      <div style={{ ...text.title, color: color.ink2 }}>没有打开的文件</div>
      <div style={{ ...text.body, maxWidth: 420 }}>
        在「资源管理器」里点击文件即可打开;AI 改动过的文件会自动开成标签,
        「问题」「源代码管理」「审查」里的条目点击后也会跳到对应的行。
      </div>
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto auto',
          gap: '5px 14px',
          ...text.micro
        }}
      >
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.keys} style={{ display: 'contents' }}>
            <dt style={{ textAlign: 'right', fontFamily: 'var(--mono-font)', color: color.ink2 }}>
              {shortcut.keys}
            </dt>
            <dd style={{ margin: 0, textAlign: 'left' }}>{shortcut.what}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export default function EditorArea({ tabs, diffFor, counts }: EditorAreaProps) {
  return (
    <section
      aria-label="编辑器"
      style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      {tabs.tabs.paths.length === 0 ? <Watermark /> : <EditorTabs tabs={tabs} diffFor={diffFor} counts={counts} />}
    </section>
  )
}
