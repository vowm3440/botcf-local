import { Suspense, lazy, useEffect, useRef } from 'react'
import TabBar from './TabBar'
import { color, text } from '../design/tokens'
import { OpenTabsApi } from '../editor/useOpenTabs'
import type { DiffCounts } from '../editor/editRegions'

/** Split out of the main bundle because the editor is the heaviest thing in it —
 *  CodeMirror is most of the ~260 KB the workbench grew by when the text surface was
 *  virtualised — and nothing needs it until a file is opened. It is a real saving for
 *  the Docker deployment, where the bundle crosses a network; on the desktop, where
 *  the same bytes come off local disk, it mostly moves the cost rather than removing
 *  it. The perf gate says which: `open per tab` covers the first open, chunk fetch
 *  included. If that number moves, this is the change to reconsider. */
const FileViewer = lazy(() => import('./FileViewer'))

/** Editor panel body: the tab strip plus a viewer for the file in front.
 *
 *  Only the active tab keeps a mounted FileViewer. A mounted one holds the file
 *  three times over — the disk snapshot, the editable buffer, and a textarea the
 *  browser lays out line by line — so keeping eight large files mounted spent over
 *  a gigabyte of renderer on seven views nobody was looking at, and made typing in
 *  the eighth noticeably late. What a hidden tab actually needs to keep is small
 *  and outlives its component: the unsaved buffer (editor/draftStore) and the view
 *  it was left in (editor/viewerState). Switching back re-reads the file, which is
 *  the same round-trip opening it took in the first place.
 *
 *  `key={activePath}` is load-bearing: without it React reuses the instance across
 *  a path change and the viewer would keep the previous file's state. */

export interface EditorTabsProps {
  tabs: OpenTabsApi
  /** Session diff for a path, when OMP changed it. */
  diffFor: (path: string) => string | undefined
  /** Added/removed line counts per path, for the tab strip. */
  counts?: ReadonlyMap<string, DiffCounts>
}

export default function EditorTabs({ tabs, diffFor, counts }: EditorTabsProps) {
  const { paths, activePath } = tabs.tabs
  // Streaming re-renders the chat page on every token; keeping the API in a ref
  // means the window listener is registered once instead of per render.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const api = tabsRef.current
      // Ctrl+Alt+←/→ cycles tabs; Alt+1…9 jumps to the nth. Both avoid the
      // browser's own tab and history shortcuts.
      if (event.ctrlKey && event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        api.cycle(event.key === 'ArrowRight' ? 1 : -1)
        return
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
        const target = api.tabs.paths[Number(event.key) - 1]
        if (!target) return
        event.preventDefault()
        api.activate(target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden' }}>
      <TabBar
        paths={paths}
        activePath={activePath}
        dirtyPaths={tabs.dirtyPaths}
        counts={counts}
        onActivate={tabs.activate}
        onClose={tabs.close}
        onCloseOthers={tabs.closeOthers}
        onCloseAll={tabs.closeAll}
        onMove={tabs.move}
      />
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {activePath && (
          <Suspense fallback={<div style={{ ...text.label, color: color.ink3, padding: 8 }}>加载编辑器…</div>}>
            <FileViewer
              key={activePath}
              path={activePath}
              diff={diffFor(activePath)}
              onClose={() => tabs.close(activePath)}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}
