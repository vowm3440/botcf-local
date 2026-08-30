import { Fragment, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { color, font, radius, text } from '../design/tokens'
import Icon from '../dock/icons'
import { diffColor } from '../editor/diffPalette'
import type { DiffCounts } from '../editor/editRegions'

/** Tab strip for the open files: horizontally scrollable, drag to reorder,
 *  middle-click or ✕ to close, a ● marker for unsaved buffers and `+N −M` for the
 *  files the assistant edited this session. Purely presentational — order and active
 *  state live in the caller's tabs model.
 *
 *  The counts are here because the agent opens a tab per file it touches: without
 *  them the strip says which files were involved but not which one it rewrote and
 *  which it fixed a typo in, and that is the first thing you want to know when eight
 *  tabs appear at once.
 *
 *  These are file tabs, not dock tabs, but they are still tabs: they reuse the
 *  dock's `.dock-tab` chrome so the two strips that sit one above the other read as
 *  the same idea at two levels, rather than as two different designers' work. */

export interface TabBarProps {
  paths: readonly string[]
  activePath: string | null
  dirtyPaths: ReadonlySet<string>
  /** Added/removed lines the assistant wrote in each file, when it did. */
  counts?: ReadonlyMap<string, DiffCounts>
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onCloseOthers: (path: string) => void
  onCloseAll: () => void
  onMove: (path: string, beforePath: string | null) => void
}

/** Show the file name; the full path stays in the tooltip. */
function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

/** Disambiguate same-named files by prefixing the parent directory. */
function labelFor(path: string, paths: readonly string[]): string {
  const name = baseName(path)
  const clashes = paths.filter((candidate) => candidate !== path && baseName(candidate) === name).length > 0
  if (!clashes) return name
  const parts = path.split('/')
  return parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name
}

const SMALL_BUTTON = {
  ...text.micro,
  padding: '2px 7px',
  border: `1px solid ${color.lineStrong}`,
  borderRadius: radius.r1,
  background: color.surface,
  color: color.ink2,
  cursor: 'pointer'
} as const

export default function TabBar({
  paths,
  activePath,
  dirtyPaths,
  counts,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onMove
}: TabBarProps) {
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)

  // Keep the focused tab visible: the strip scrolls once tabs overflow, and the
  // active tab is often changed from outside (agent edits, tree clicks).
  useEffect(() => {
    if (!activePath) return
    stripRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath, paths])

  const onTabDrop = (targetPath: string | null) => (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const dragged = draggingPath
    setDraggingPath(null)
    setDropBefore(null)
    if (dragged) onMove(dragged, targetPath)
  }

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="打开的文件"
      className="dock-tabs"
      onDragOver={(event) => {
        // Dropping on the strip background moves the tab to the end.
        if (draggingPath) event.preventDefault()
      }}
      onDrop={onTabDrop(null)}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        flex: 'none',
        padding: '0 4px',
        background: color.surface,
        borderBottom: `1px solid ${color.line}`
      }}
    >
      {paths.map((path) => {
        const active = path === activePath
        const dirty = dirtyPaths.has(path)
        const count = counts?.get(path)
        return (
          <Fragment key={path}>
            {dropBefore === path && <span aria-hidden className="dock-caret" />}
            <span
              role="tab"
              aria-selected={active}
              data-active={active ? 'true' : 'false'}
              data-lifted={draggingPath === path ? 'true' : 'false'}
              className="dock-tab"
              tabIndex={active ? 0 : -1}
              title={`${path}${dirty ? ' · 未保存' : ''}${count ? ` · AI 改动 +${count.added} −${count.removed}` : ''}`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', path)
                setDraggingPath(path)
              }}
              onDragEnd={() => {
                setDraggingPath(null)
                setDropBefore(null)
              }}
              onDragOver={(event) => {
                if (!draggingPath || draggingPath === path) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const rect = event.currentTarget.getBoundingClientRect()
                // Left half inserts before this tab, right half after it.
                const before = event.clientX < rect.left + rect.width / 2 ? path : nextOf(paths, path)
                setDropBefore(before)
              }}
              onDrop={(event) => onTabDrop(dropBefore)(event)}
              onPointerDown={() => onActivate(path)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onActivate(path)
                }
                if (event.key === 'Delete') {
                  event.preventDefault()
                  onClose(path)
                }
              }}
              onAuxClick={(event) => {
                // Middle click closes, matching editors and browsers.
                if (event.button === 1) {
                  event.preventDefault()
                  onClose(path)
                }
              }}
            >
              <span className="dock-tab-label" style={{ fontFamily: font.mono, fontWeight: active ? 600 : 400 }}>
                {labelFor(path, paths)}
              </span>
              {count && (
                <span
                  aria-hidden
                  style={{ flex: 'none', fontFamily: font.mono, fontSize: 9.5, letterSpacing: -0.2, opacity: active ? 1 : 0.7 }}
                >
                  <span style={{ color: diffColor.addInk }}>+{count.added}</span>
                  <span style={{ color: diffColor.delInk, marginLeft: 3 }}>−{count.removed}</span>
                </span>
              )}
              {dirty && (
                <span aria-hidden title="未保存" style={{ color: color.accent, fontSize: 9, flex: 'none' }}>
                  ●
                </span>
              )}
              <button
                type="button"
                className="dock-tab-close"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(path)
                }}
                aria-label={`关闭 ${path}`}
                title="关闭(中键亦可)"
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          </Fragment>
        )
      })}
      {paths.length > 1 && activePath && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto', paddingLeft: 8, flex: 'none' }}>
          <button type="button" onClick={() => onCloseOthers(activePath)} title="关闭其他标签页" style={SMALL_BUTTON}>
            仅保留当前
          </button>
          <button type="button" onClick={onCloseAll} title="关闭全部标签页" style={SMALL_BUTTON}>
            全部关闭
          </button>
        </span>
      )}
    </div>
  )
}

/** The tab after `path`, or null when it is the last one. */
function nextOf(paths: readonly string[], path: string): string | null {
  const index = paths.indexOf(path)
  return index >= 0 && index + 1 < paths.length ? paths[index + 1] : null
}
