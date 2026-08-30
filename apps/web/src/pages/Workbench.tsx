import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, type AccessMode, type RouteInfo } from '../api'
import ChatView from '../components/ChatView'
import DiagnosticsPanel from '../components/DiagnosticsPanel'
import EditorArea from '../components/EditorArea'
import FileTree from '../components/FileTree'
import GitPanel from '../components/GitPanel'
import PreviewPanel from '../components/PreviewPanel'
import ProjectConfigPanel from '../components/ProjectConfigPanel'
import ReviewPanel from '../components/ReviewPanel'
import StatusBar from '../components/StatusBar'
import TaskPanel from '../components/TaskPanel'
import TerminalPanel from '../components/TerminalPanel'
import UsageLogs from './UsageLogs'
import DockFrame, { DockEmptyState } from '../dock/DockFrame'
import DockRail from '../dock/DockRail'
import { locatePart } from '../dock/dockModel'
import type { PartId } from '../dock/parts'
import { useDock } from '../dock/useDock'
import { useChatSession } from '../chat/useChatSession'
import { onOpenFileRequest } from '../editor/openFile'
import { buildDiffCounts, totalDiffCounts } from '../editor/editRegions'
import { useOpenTabs } from '../editor/useOpenTabs'
import { useWorkbenchBadges } from '../workbench/useWorkbenchBadges'
import { onWorkspaceChanged } from '../workspace/events'
import { isOutsideWorkspace, rootNameOf } from '../workspace/paths'

/** The workbench: a rail, a dock, a status strip.
 *
 *  Everything the user can see is a *part* in the dock — the file tree, the editor,
 *  the terminal, the conversation — and the dock owns where each one sits, how big
 *  it is and which of them share a tab strip. This page owns the other half: what a
 *  part *is*. `renderPart` is the whole seam between the two, which is why adding a
 *  feature is a row in the catalogue plus a case here, and never an edit to a
 *  layout.
 *
 *  Two things deliberately live above the dock. The conversation's state is in
 *  `useChatSession` at this level, so the stream survives the pane being closed,
 *  dragged to another edge or stacked behind a tab. The open editor tabs are in
 *  `useOpenTabs` for the same reason. Losing a running turn to a layout change would
 *  be a bad trade for any amount of flexibility.
 *
 *  The usage log is not a part: it is a full-frame report that takes over the dock
 *  and leaves it mounted behind, which is the cheapest way to keep a stream alive
 *  while looking at something else. */

export interface WorkbenchProps {
  route: RouteInfo | null
  ompRunning: boolean
  /** Tool-approval mode, shown in the composer footer. */
  accessMode: AccessMode
  /** Usage logs need the BotCF backend; third-party mode has no log store. */
  logsAvailable: boolean
}

type Page = 'workbench' | 'logs'

export default function Workbench({ route, ompRunning, accessMode, logsAvailable }: WorkbenchProps) {
  const dock = useDock()
  const [page, setPage] = useState<Page>('workbench')
  /** Keep the log page mounted once visited: it holds filters and a loaded page of
   *  results that a display toggle should not throw away. */
  const [logsVisited, setLogsVisited] = useState(false)
  const badges = useWorkbenchBadges()
  /** Multi-tab editor; v2 tab paths carry the workspace root name, so they are not
   *  interchangeable with v1's bare relative paths. */
  const tabs = useOpenTabs('botcf.tabs.v2')

  /** A dirty front tab keeps focus: a new file opens behind it. */
  const openFile = useCallback(
    (path: string, options?: { activate?: boolean }) => {
      tabs.open(path, options ?? { activate: !tabs.activeIsDirty })
    },
    [tabs]
  )

  const session = useChatSession({ route, ompRunning, openFile, activeIsDirty: tabs.activeIsDirty })

  const openPage = useCallback((next: Page) => {
    if (next === 'logs') setLogsVisited(true)
    setPage(next)
  }, [])

  // Stable refs for the window-event handlers below, which are registered once and
  // would otherwise close over a stale render during streaming.
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const dockRef = useRef(dock)
  dockRef.current = dock

  // A root removed from the workspace leaves tabs that can no longer be read. Close
  // those, but keep any with unsaved edits — silently dropping a draft is worse than
  // leaving a tab that reports an error.
  useEffect(
    () =>
      onWorkspaceChanged(() => {
        api
          .workspace()
          .then(({ roots }) => {
            const names = new Set(roots.map((root) => root.name))
            const editor = tabsRef.current
            for (const path of editor.tabs.paths) {
              if (!names.has(rootNameOf(path)) && !editor.dirtyPaths.has(path)) editor.close(path)
            }
          })
          .catch(() => undefined)
      }),
    []
  )

  // Git, review and diagnostics all hand files to the editor through this signal;
  // the FileViewer for that path scrolls to the line (editor/openFile.ts). For that
  // to mean anything the editor has to be on screen, so leave the log page and let
  // the dock bring the editor forward — wherever the user has put it.
  useEffect(
    () =>
      onOpenFileRequest((request) => {
        if (isOutsideWorkspace(request.path)) return
        setPage('workbench')
        dockRef.current.openPart('editor')
        openFileRef.current(request.path, { activate: request.activate !== false })
      }),
    []
  )

  /** Whether a part is the one actually on screen. The transcript needs it: a
   *  hidden element cannot be scrolled to the bottom. */
  const isFront = useCallback(
    (part: PartId): boolean => {
      const { root, zoomed } = dock.arrangement
      if (!root) return false
      const found = locatePart(root, part)
      if (!found || found.group.active !== part) return false
      return !zoomed || zoomed === found.group.id
    },
    [dock.arrangement]
  )

  const onWorkbenchPage = page === 'workbench'
  const chatVisible = onWorkbenchPage && isFront('chat')

  /** How many lines the assistant wrote in each changed file. Derived once here so the
   *  tree, the tab strip and the status bar all quote the same number. */
  const editCounts = useMemo(() => buildDiffCounts(session.changedFiles.values()), [session.changedFiles])
  const editTotals = useMemo(
    () => ({ ...totalDiffCounts(editCounts.values()), files: editCounts.size }),
    [editCounts]
  )

  const renderPart = useCallback(
    (part: PartId): ReactNode => {
      switch (part) {
        case 'explorer':
          return <FileTree changed={session.changedFiles} onOpenFile={openFile} activePath={tabs.tabs.activePath} />
        case 'scm':
          return <GitPanel />
        case 'run':
          return <TaskPanel />
        case 'review':
          return <ReviewPanel />
        case 'config':
          return <ProjectConfigPanel />
        case 'editor':
          return (
            <EditorArea
              tabs={tabs}
              diffFor={(path) => session.changedFiles.get(path)?.diff}
              counts={editCounts}
            />
          )
        case 'problems':
          return <DiagnosticsPanel />
        case 'terminal':
          return <TerminalPanel />
        case 'preview':
          return <PreviewPanel onClose={() => dockRef.current.closePart('preview')} />
        case 'chat':
          return (
            <ChatView
              session={session}
              route={route}
              ompRunning={ompRunning}
              accessMode={accessMode}
              active={chatVisible}
              onOpenFile={openFile}
            />
          )
      }
    },
    [accessMode, chatVisible, editCounts, ompRunning, openFile, route, session, tabs]
  )

  const partBadges = useMemo(
    () => ({
      problems: badges.problems.errors + badges.problems.warnings,
      review: badges.review.pending
    }),
    [badges.problems.errors, badges.problems.warnings, badges.review.pending]
  )

  const partAlerts = useMemo(
    () => ({ problems: badges.problems.errors > 0, review: badges.review.failed > 0 }),
    [badges.problems.errors, badges.review.failed]
  )

  return (
    <>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
        <DockRail
          dock={dock}
          badges={partBadges}
          alerts={partAlerts}
          extras={[
            {
              id: 'logs',
              label: '日志',
              title: '使用日志 — 调用记录、用量与筛选',
              icon: 'logs',
              active: page === 'logs',
              onClick: () => openPage(onWorkbenchPage ? 'logs' : 'workbench')
            }
          ]}
        />

        {/* The log page covers the dock instead of replacing it: the dock keeps its
            mounted parts, and coming back costs nothing. */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: onWorkbenchPage ? 'none' : 'flex' }}>
          {logsVisited && <UsageLogs available={logsAvailable} />}
        </div>

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: onWorkbenchPage ? 'flex' : 'none' }}>
          <DockFrame
            dock={dock}
            badges={partBadges}
            alerts={partAlerts}
            renderPart={renderPart}
            empty={<DockEmptyState />}
          />
        </div>
      </div>

      <StatusBar
        route={route}
        ompRunning={ompRunning}
        streaming={session.streaming}
        sessionTokens={session.sessionTokens}
        contextUsage={session.contextUsage}
        problems={badges.problems}
        review={badges.review}
        openTabs={tabs.tabs.paths.length}
        aiEdits={editTotals}
        onOpenProblems={() => {
          openPage('workbench')
          dock.openPart('problems')
        }}
        onOpenReview={() => {
          openPage('workbench')
          dock.openPart('review')
        }}
        onOpenExplorer={() => {
          openPage('workbench')
          dock.openPart('explorer')
        }}
      />
    </>
  )
}
