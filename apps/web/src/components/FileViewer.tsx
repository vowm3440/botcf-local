import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ContentEncoding } from '../api'
import { clearDraft, clearSpilledDraft, getDraft, restoreRecoveredDraft, restoreSpilledDraft, setDraft as cacheDraft, type FileDraft } from '../editor/draftStore'
import { draftAction, isDirty, type BufferShape } from '../editor/draftPolicy'
import { getViewerState, rememberViewerState } from '../editor/viewerState'
import { countLines } from '../editor/lineCount'
import { onOpenFileRequest } from '../editor/openFile'
import CodeSurface, { type CodeSurfaceHandle } from '../editor/CodeSurface'
import InlineDiffView, { type InlineDiffHandle } from '../editor/InlineDiffView'
import ViewerHeader, { type ViewMode } from '../editor/ViewerHeader'
import {
  EMPTY_EDIT_REGIONS,
  applyAnchors,
  hasStaleRegions,
  nextRegion,
  parseEditRegions,
  previousRegion,
  type EditRegion
} from '../editor/editRegions'
import { color, text } from '../design/tokens'
import DiffView from './DiffView'

interface FileViewerProps {
  path: string
  /** Session diff for this file, when OMP changed it — enables the 内联/差异 views. */
  diff?: string
  onClose: () => void
}

interface FileData {
  content: string
  size: number
  truncated: boolean
  binary: boolean
  encoding: ContentEncoding
  mtimeMs: number
}

const ENCODING_LABELS: Partial<Record<ContentEncoding, string>> = {
  utf16le: 'UTF-16LE',
  utf16be: 'UTF-16BE',
  utf32le: 'UTF-32LE',
  utf32be: 'UTF-32BE'
}

/** Stable empty array: the buffer is only split when a diff makes the lines
 *  worth having, and a fresh `[]` per render would defeat every memo below it. */
const NO_LINES: readonly string[] = []

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** Editor panel body for one tab.
 *
 *  Three views of one file: the editable buffer with the assistant's edits marked in
 *  the gutter, the same file with those edits shown in place, and the raw unified diff.
 *  All three read the *buffer*, not the last disk snapshot, so what is highlighted is
 *  what is on screen — the edits are re-anchored by content on every keystroke rather
 *  than trusting the line numbers the diff was written with (editor/editRegions.ts).
 *
 *  Disk content refreshes after each finished turn without clobbering unsaved edits.
 *  Only the front tab keeps one of these mounted, so everything that has to outlive a
 *  tab switch is deliberately outside the component: the unsaved buffer in
 *  editor/draftStore, the view mode and reading position in editor/viewerState. */
export default function FileViewer({ path, diff, onClose }: FileViewerProps) {
  /** Read once: what this tab looked like when it was last in front. */
  const remembered = useRef(getViewerState(path))
  const [mode, setMode] = useState<ViewMode>(() => remembered.current?.mode ?? (diff ? 'inline' : 'content'))
  const [data, setData] = useState<FileData | null>(null)
  /** The document handed *to* the editor: a restored draft on mount, then only what
   *  replaces it from outside — a disk read, 放弃修改, a save. Typing does not come
   *  back through here, which is the point (see `shape`). */
  /** Read once per mount: the live draft, else a spill left by budget eviction.
   *  Spill content is re-registered below so the dirty marker and the save-time
   *  mtime conflict check see it exactly like a draft that was never evicted. */
  const initial = useRef<FileDraft | null>(null)
  if (initial.current === null) initial.current = getDraft(path) ?? restoreSpilledDraft(path) ?? null
  const spilledMount = useRef(initial.current !== null && getDraft(path) === undefined)
  const [seed, setSeed] = useState(() => initial.current?.content ?? '')
  /** The cheap facts about the live buffer, reported per keystroke by the editor.
   *  The text itself stays in the editor until something actually needs it. */
  const [shape, setShape] = useState<BufferShape>(() => {
    const restored = initial.current?.content ?? ''
    return { length: restored.length, lines: countLines(restored) }
  })
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fullInline, setFullInline] = useState(() => remembered.current?.fullInline ?? false)
  /** A line to scroll to once the view that shows it has mounted. `align: 'top'`
   *  marks a restored reading position, which has to land exactly where it was
   *  read from rather than half a screen above it. */
  const [pending, setPending] = useState<{ line: number; select: boolean; align?: 'top' } | null>(null)
  const surfaceRef = useRef<CodeSurfaceHandle | null>(null)
  const inlineRef = useRef<InlineDiffHandle | null>(null)
  /** Last line looked at, so change navigation continues from there while the
   *  editable surface is unmounted (inline and diff views), and so the position
   *  can be handed to viewerState when the tab goes to the back. */
  const cursorRef = useRef(remembered.current?.line ?? 1)
  /** True until the first disk read lands, so a restored draft is not treated as
   *  a match against the still-empty snapshot. */
  const restoredDraft = useRef(initial.current !== null)
  /** The reading position is restored once, after the first snapshot arrives. */
  const restoredPosition = useRef(false)

  const editable = data !== null && !data.binary && !data.truncated
  /** The live buffer, wherever it currently is.
   *
   *  The editor owns it while one is mounted — but only the 内容 view mounts one, and a
   *  file the assistant changed opens in 内联. With no editor to ask, the unsaved buffer
   *  is whatever the draft cache holds; with neither, there is no buffer and the file
   *  *is* the snapshot. Returning `''` for that last case is what once marked every
   *  changed file unsaved and cached an empty draft for it. */
  const readBuffer = useCallback(
    (): string | null => surfaceRef.current?.getText() ?? getDraft(path)?.content ?? null,
    [path]
  )
  // The text is only read when the two lengths agree, which ordinary typing never
  // produces — see editor/draftPolicy.
  const dirty = data !== null && !data.binary && isDirty(shape, data.content, readBuffer)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const dataRef = useRef(data)
  dataRef.current = data

  // The line *count* comes from the editor, which knows it without building a string.
  // The line *array* is only ever read to re-anchor the assistant's edits and to
  // render the inline diff, both of which need a diff — so without one, splitting a
  // 948 KB buffer into 12,001 strings on every keystroke bought nothing but GC
  // pressure. With one, it is the price of showing where the assistant wrote.
  const lineCount = data !== null && !editable ? countLines(data.content) : shape.lines
  const lines = useMemo(
    () => (diff ? (editable ? (surfaceRef.current?.getText() ?? seed) : (data?.content ?? '')).split('\n') : NO_LINES),
    // `shape` stands in for the buffer: the text is not state any more, but every
    // change to it produces a new shape, so this re-anchors exactly as often as before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diff, editable, seed, shape, data]
  )
  // Parsing is tied to the diff, anchoring to the buffer: the first is done once per
  // turn, the second on every keystroke, and they must not share a memo.
  const parsed = useMemo(() => (diff ? parseEditRegions(diff) : EMPTY_EDIT_REGIONS), [diff])
  const edits = useMemo(
    () => (data && !data.binary ? applyAnchors(parsed, lines) : EMPTY_EDIT_REGIONS),
    [data, lines, parsed]
  )
  const stale = hasStaleRegions(parsed, edits)
  const regionsRef = useRef(edits.regions)
  regionsRef.current = edits.regions

  /** Serialise the buffer into the draft cache. One call is one ~948 KB string, so
   *  every caller of this is a deliberate decision about when it is worth it. */
  const cacheNow = useCallback(() => {
    const snapshot = dataRef.current
    if (!snapshot) return
    const content = surfaceRef.current?.getText()
    // Only a mounted editor may seed the cache. Falling back to `''` here is the same
    // confusion `readBuffer` guards against, with a worse ending — this one *writes*
    // the empty buffer, and the next time the tab opens that is what it shows.
    if (content === undefined) return
    cacheDraft(path, { content, baseMtimeMs: snapshot.mtimeMs })
  }, [path])

  // A draft evicted under the byte budget is recovered from the spill cache on
  // reopen: re-register it so the dirty marker and draftPolicy treat it as a
  // draft that was never evicted (its base mtime drives the same conflict path).
  useEffect(() => {
    if (!spilledMount.current || !initial.current) return
    spilledMount.current = false
    cacheDraft(path, initial.current)
    restoredDraft.current = true
    setNotice('已从恢复缓存取回未保存的修改,保存前会检查磁盘冲突')
  }, [path])

  // The same recovery one layer deeper: after a page reload the in-memory spill
  // is gone, and the only copy left is in the server's disk recovery log. Ask
  // once per mount, and only while nothing newer has happened in this viewer —
  // a live draft or on-screen edits always win over the log.
  const recoveryChecked = useRef(false)
  useEffect(() => {
    if (recoveryChecked.current || initial.current !== null || getDraft(path) !== undefined) return
    recoveryChecked.current = true
    let cancelled = false
    void restoreRecoveredDraft(path).then((recovered) => {
      if (cancelled || !recovered) return
      if (getDraft(path) !== undefined || dirtyRef.current) return
      cacheDraft(path, { content: recovered.content, baseMtimeMs: recovered.baseMtimeMs })
      restoredDraft.current = true
      setSeed(recovered.content)
      setShape({ length: recovered.content.length, lines: countLines(recovered.content) })
      const moved = recovered.diskMtimeMs !== null && recovered.diskMtimeMs !== recovered.baseMtimeMs
      setNotice(
        moved
          ? '已从恢复日志取回未保存的修改;磁盘文件已被外部修改,保存时会提示冲突'
          : '已从恢复日志取回未保存的修改,保存前会检查磁盘冲突'
      )
    })
    return () => {
      cancelled = true
    }
  }, [path])

  // The draft cache is created the moment the buffer diverges from disk — the ● marker
  // and the tab-eviction keep-set both read it and both have to be right immediately —
  // and its *content* is refreshed only where something will read it: the editor's
  // flush on the way out, and after a save. See editor/draftPolicy.
  useEffect(() => {
    if (!data) return
    const action = draftAction(dirty, getDraft(path) !== undefined)
    if (action.kind === 'write') cacheNow()
    else if (action.kind === 'clear') clearDraft(path)
  }, [cacheNow, data, dirty, path])

  // 离开这个标签时留下轻量的视图状态,回来时接着看同一处。
  const viewRef = useRef({ mode, fullInline })
  viewRef.current = { mode, fullInline }
  useEffect(
    () => () => {
      rememberViewerState(path, { ...viewRef.current, line: cursorRef.current })
    },
    [path]
  )

  const load = useCallback(async (options?: { discard?: boolean }) => {
    try {
      const res = await api.fileContent(path)
      setData({ content: res.content, size: res.size, truncated: res.truncated, binary: res.binary, encoding: res.encoding, mtimeMs: res.mtimeMs })
      // 有未保存修改(或从缓存恢复的草稿)时保留草稿,只更新磁盘快照;
      // 保存时靠 mtime 检测冲突。
      const keepDraft = !options?.discard && (dirtyRef.current || restoredDraft.current)
      if (!keepDraft) {
        setSeed(res.content)
        setShape({ length: res.content.length, lines: countLines(res.content) })
      }
      restoredDraft.current = false
      if (options?.discard) {
        clearSpilledDraft(path)
        setNotice(null)
      }
      setError(null)
    } catch (e) {
      setData(null)
      setError(e instanceof Error ? e.message : '文件读取失败')
    }
  }, [path])

  const firstRun = useRef(true)
  useEffect(() => {
    // On mount the view mode is already the remembered one; only a *new* diff
    // arriving afterwards should switch the view out from under the reader.
    if (firstRun.current) firstRun.current = false
    else if (!dirtyRef.current) setMode(diff ? 'inline' : 'content')
    load().catch(() => undefined)
  }, [load, diff])

  // 回到这个标签时,把上次停留的位置带回来(只做一次,且不抢焦点)。
  useEffect(() => {
    const line = remembered.current?.line ?? 1
    if (!data || restoredPosition.current) return
    restoredPosition.current = true
    if (line > 1) setPending({ line, select: false, align: 'top' })
  }, [data])

  useEffect(() => {
    const onTurn = () => { load().catch(() => undefined) }
    window.addEventListener('botcf:turn-complete', onTurn)
    return () => window.removeEventListener('botcf:turn-complete', onTurn)
  }, [load])

  // 诊断中心/Git/审查面板可以要求跳到某一行。
  useEffect(
    () =>
      onOpenFileRequest((request) => {
        if (request.path !== path || !request.line) return
        setMode('content')
        setPending({ line: request.line, select: true })
      }),
    [path]
  )

  // 行跳转:等目标视图挂载后再滚动,可编辑时同时选中整行。
  useEffect(() => {
    if (!pending || !data) return
    const timer = window.setTimeout(() => {
      if (mode === 'inline') inlineRef.current?.revealLine(pending.line)
      else surfaceRef.current?.revealLine(pending.line, { select: pending.select && editable, ...(pending.align ? { align: pending.align } : {}) })
      cursorRef.current = pending.line
      setPending(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [pending, data, mode, editable])

  const save = useCallback(async () => {
    if (!data || !editable || !dirtyRef.current || saving) return
    // One serialise, at the only moment the bytes have to leave the editor.
    const content = surfaceRef.current?.getText() ?? ''
    setSaving(true)
    try {
      const res = await api.saveFile({ path, content, baseMtimeMs: data.mtimeMs })
      setData((prev) => (prev ? { ...prev, content, size: res.size, mtimeMs: res.mtimeMs } : prev))
      clearSpilledDraft(path)
      setNotice('已保存')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [data, editable, path, saving])

  const gotoRegion = useCallback((direction: 1 | -1) => {
    const regions = regionsRef.current
    if (regions.length === 0) return
    const from = surfaceRef.current?.currentLine() ?? cursorRef.current
    const region = direction > 0 ? nextRegion(regions, from) : previousRegion(regions, from)
    if (!region) return
    // Selecting the destination moves the caret there, which is what makes the next
    // press advance instead of finding the same change again.
    setPending({ line: region.start, select: true })
  }, [])

  const inspectRegion = useCallback((region: EditRegion) => {
    setMode('inline')
    setPending({ line: region.start, select: false })
  }, [])

  useEffect(() => {
    // Only the front tab keeps a viewer mounted, so these are always this file's keys.
    const onKey = (event: KeyboardEvent) => {
      // 有未保存修改时 Escape 不关闭面板,避免误触丢失编辑。
      if (event.key === 'Escape' && !dirtyRef.current) onClose()
      // Alt+F5 / Shift+Alt+F5:在 AI 改动之间跳转(与 VS Code 的「下一处更改」一致)。
      if (event.altKey && event.key === 'F5') {
        event.preventDefault()
        gotoRegion(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gotoRegion, onClose])

  const meta = (
    <>
      {notice ? `${notice} · ` : ''}
      {data ? formatSize(data.size) : ''}
      {data && !data.binary ? ` · ${lineCount} 行` : ''}
      {data && ENCODING_LABELS[data.encoding] ? ` · ${ENCODING_LABELS[data.encoding]}` : ''}
      {data?.truncated ? ' · 超过 1 MB,只读预览' : ''}
      {mode === 'diff' ? ' · 本会话 OMP 变更' : ''}
    </>
  )

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: color.surface, overflow: 'hidden' }}>
      <ViewerHeader
        mode={mode}
        onMode={setMode}
        hasDiff={Boolean(diff)}
        dirty={dirty}
        editable={editable}
        saving={saving}
        onSave={() => { save().catch(() => undefined) }}
        onDiscard={() => { load({ discard: true }).catch(() => undefined) }}
        edits={edits}
        stale={stale}
        onPreviousRegion={() => gotoRegion(-1)}
        onNextRegion={() => gotoRegion(1)}
        meta={meta}
        metaAlert={Boolean(notice) && notice !== '已保存'}
      />
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, padding: 8, display: 'flex', flexDirection: 'column' }}>
        {mode === 'diff' && diff && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <DiffView diff={diff} />
          </div>
        )}
        {mode === 'inline' && diff && data && !data.binary && (
          <InlineDiffView
            ref={inlineRef}
            lines={lines}
            regions={edits.regions}
            full={fullInline}
            onToggleFull={() => setFullInline((previous) => !previous)}
          />
        )}
        {mode === 'inline' && data?.binary && <Hint>二进制文件,无法显示内联差异。</Hint>}
        {mode === 'content' && error && <Hint alert>{error}</Hint>}
        {mode === 'content' && data?.binary && <Hint>二进制文件,无法预览。</Hint>}
        {mode === 'content' && data && !data.binary && (
          <CodeSurface
            ref={surfaceRef}
            value={editable ? seed : data.content}
            editable={editable}
            onDocChange={(info) => { setShape(info); setNotice(null) }}
            onFlush={(text) => {
              // The editor's last word before it is torn down. Its cleanup runs before
              // this component's, so this is the only point at which an unsaved buffer
              // can still be read — a tab switch, a dock rearrangement, a close.
              const snapshot = dataRef.current
              if (dirtyRef.current && snapshot) cacheDraft(path, { content: text, baseMtimeMs: snapshot.mtimeMs })
            }}
            onSave={() => { save().catch(() => undefined) }}
            onScrollLine={(line) => { cursorRef.current = line }}
            regions={edits.regions}
            ariaLabel={editable ? `编辑 ${path}` : `查看 ${path}`}
            onSelectRegion={diff ? inspectRegion : undefined}
          />
        )}
        {mode === 'content' && !data && !error && <Hint>加载中…</Hint>}
      </div>
    </div>
  )
}

function Hint({ children, alert = false }: { children: string; alert?: boolean }) {
  return <div style={{ ...text.label, color: alert ? color.red : color.ink3 }}>{children}</div>
}
