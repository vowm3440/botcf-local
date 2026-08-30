import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Extension, Range } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutter, keymap, lineNumbers } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { history, historyKeymap, standardKeymap } from '@codemirror/commands'
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, CODE_PAD_TOP, diffColor } from './diffPalette'
import { regionEnd, type EditRegion } from './editRegions'
import { color, radius, font } from '../design/tokens'

/** One monospace surface — editable or not — with the assistant's edits drawn on it.
 *
 *  This renders the viewport, not the file. That is the whole reason it is CodeMirror
 *  and not the `<textarea>` it used to be. The gate measured what a textarea costs on
 *  the load this editor is meant to survive: with one 948 KB / 12,001 line file mounted,
 *  the renderer sat ~400 MiB over an empty workbench while the JS heap never passed
 *  ~45 MiB, so almost all of it was Blink keeping layout, line boxes and shaping caches
 *  for every line in the document whether or not anyone could see it. A textarea holds
 *  its whole value by definition, so there is no way to window it from outside — the
 *  component itself had to go.
 *
 *  The line-number column was the other half of that cost and windowing it first was
 *  worth doing, because it produced the number that justified this change rather than
 *  an assumption: rendering ~345 line numbers instead of 12,001 returned only ~41 MiB
 *  of ~357. Layout cost tracks characters, not lines, and the gutter's rows are five
 *  characters against the text's seventy-eight. That left the text surface holding
 *  ~316 MiB, which is what this is for. `lineNumbers()` windows the gutter natively, so
 *  the hand-rolled one is gone with the textarea.
 *
 *  Alignment is by construction: the row height is a constant (diffPalette.ts) that the
 *  theme, the change bands and the gutter all use, and lines never wrap. Wrapping is
 *  off by default here and must stay off — a soft-wrapped line takes two rows and every
 *  band below it would point at the wrong code. */

export interface CodeSurfaceHandle {
  /** Scroll a 1-based line into view — centred by default, or to the top edge,
   *  which is the alignment `onScrollLine` reports and therefore the only one that
   *  round-trips when a reading position is restored. Optionally selects the line. */
  revealLine: (line: number, options?: { select?: boolean; align?: 'center' | 'top' }) => void
  /** Where the caret is (editable) or the middle of the viewport (read-only). */
  currentLine: () => number
  focus: () => void
  /** The whole document, as a string.
   *
   *  A method rather than a prop the caller already holds, because serialising this
   *  buffer is the single most expensive thing about editing it: ~948 KB per call on
   *  the gate's fixture. The editor owns the document; callers ask for it when they
   *  actually need it — to save, to anchor a diff, to hand a draft to the cache — and
   *  not on every keystroke. Doing it per keystroke is what drove V8's committed heap
   *  from 6 MiB to 88 MiB across one run of the gate. */
  getText: () => string
}

/** What the caller needs on every keystroke, which is not the text. */
export interface DocInfo {
  lines: number
  length: number
}

export interface CodeSurfaceProps {
  /** The document to show. Only changes from *outside* the editor — a disk read,
   *  放弃修改, a restored draft — never as an echo of typing, because the editor's own
   *  edits no longer round-trip through the caller's state. */
  value: string
  editable: boolean
  /** Called on every document change, with the cheap facts about it. The text itself
   *  is available through `getText()` when it is really needed. */
  onDocChange?: (info: DocInfo) => void
  /** Called with the final text just before the editor is torn down, so a caller that
   *  keeps unsaved buffers has one at the only moment it can still be read.
   *
   *  This runs in the view's own cleanup, which React runs *before* the parent's — so
   *  a parent that tried to call `getText()` from its own unmount cleanup would find
   *  the view already destroyed and quietly cache an empty draft. That is a lost edit,
   *  and it is why the flush is pushed from here rather than pulled from there. */
  onFlush?: (text: string) => void
  /** Ctrl/Cmd+S inside the surface. */
  onSave?: () => void
  /** Anchored, merged regions from `trackEdits`. */
  regions: readonly EditRegion[]
  ariaLabel: string
  /** Click a change bar in the gutter. */
  onSelectRegion?: (region: EditRegion) => void
  /** Top visible line, on every scroll frame. Deliberately a callback rather than
   *  state: the caller stores it in a ref so the tab can be reopened where it was
   *  left, and re-rendering the editor per scroll frame is what viewport rendering
   *  exists to avoid. */
  onScrollLine?: (line: number) => void
}

/** The anchored regions, as editor state. Held here rather than read from props at
 *  render time so that both the line decorations and the gutter bars see the same
 *  set, and so that a change to it is one transaction rather than a rebuilt view. */
const setRegions = StateEffect.define<readonly EditRegion[]>()

const regionsField = StateField.define<readonly EditRegion[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setRegions)) return effect.value
    }
    return value
  }
})

const ADD_LINE = Decoration.line({ class: 'cm-region-add' })
const MODIFY_LINE = Decoration.line({ class: 'cm-region-modify' })
/** A deletion occupies no line, so it is drawn as a rule on the boundary above the
 *  line that now sits where the removed text was — marking that line as changed would
 *  claim the assistant touched code it never wrote. */
const DELETE_LINE = Decoration.line({ class: 'cm-region-delete' })

function decorationFor(kind: EditRegion['kind']): Decoration {
  return kind === 'add' ? ADD_LINE : MODIFY_LINE
}

function regionDecorations(state: EditorState, regions: readonly EditRegion[]): DecorationSet {
  const total = state.doc.lines
  const ranges: Range<Decoration>[] = []
  for (const region of regions) {
    if (region.count === 0) {
      const line = state.doc.line(Math.min(Math.max(region.start, 1), total))
      ranges.push(DELETE_LINE.range(line.from))
      continue
    }
    const last = Math.min(regionEnd(region), total)
    for (let number = Math.max(region.start, 1); number <= last; number++) {
      ranges.push(decorationFor(region.kind).range(state.doc.line(number).from))
    }
  }
  // Sorted on the way in: regions arrive anchored by content and may not be ordered.
  return Decoration.set(ranges, true)
}

const regionHighlight = EditorView.decorations.compute([regionsField, 'doc'], (state) =>
  regionDecorations(state, state.field(regionsField))
)

function regionAt(regions: readonly EditRegion[], line: number): EditRegion | null {
  for (const region of regions) {
    if (region.count === 0 ? region.start === line : line >= region.start && line <= regionEnd(region)) return region
  }
  return null
}

function barTitle(region: EditRegion): string {
  if (region.kind === 'delete') return `AI 删除了 ${region.removed} 行 · 点击查看`
  const lines = region.count === 1 ? `第 ${region.start} 行` : `第 ${region.start}–${regionEnd(region)} 行`
  if (region.kind === 'add') return `AI 新增 ${lines}(${region.added} 行)· 点击查看`
  return `AI 改写 ${lines}(+${region.added} −${region.removed})· 点击查看`
}

class RegionBar extends GutterMarker {
  constructor(
    readonly region: EditRegion,
    readonly clickable: boolean
  ) {
    super()
  }

  eq(other: RegionBar): boolean {
    return other.region === this.region && other.clickable === this.clickable
  }

  toDOM(): HTMLElement {
    const bar = document.createElement('span')
    bar.className = `cm-region-bar cm-region-bar-${this.region.kind}`
    bar.title = barTitle(this.region)
    if (this.clickable) bar.style.cursor = 'pointer'
    return bar
  }
}

/** Reserves the column's width even on a file with no changes, so the text does not
 *  shift sideways the first time the assistant edits it. */
class BarSpacer extends GutterMarker {
  toDOM(): HTMLElement {
    const spacer = document.createElement('span')
    spacer.className = 'cm-region-bar'
    return spacer
  }
}

const BAR_SPACER = new BarSpacer()

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: `${CODE_FONT_SIZE}px`,
    backgroundColor: color.surface,
    color: diffColor.ink
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: font.mono,
    lineHeight: `${CODE_LINE_HEIGHT}px`,
    overflow: 'auto'
  },
  '.cm-content': {
    padding: `${CODE_PAD_TOP}px 0`,
    caretColor: diffColor.ink
  },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': {
    backgroundColor: diffColor.metaRow,
    color: diffColor.gutterInk,
    border: 'none',
    borderRight: `1px solid rgba(0, 0, 0, 0.06)`
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 8px' },
  '.cm-region-gutter': { width: '6px' },
  '.cm-region-gutter .cm-gutterElement': { position: 'relative' },
  '.cm-region-bar': {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: '3px',
    borderRadius: '1px'
  },
  '.cm-region-bar-add': { background: diffColor.addBar },
  '.cm-region-bar-modify': { background: diffColor.modifyBar },
  '.cm-region-bar-delete': { background: diffColor.delBar, width: '6px', bottom: 'auto', height: '2px' },
  '.cm-region-add': { backgroundColor: diffColor.addBand },
  '.cm-region-modify': { backgroundColor: diffColor.modifyBand },
  '.cm-region-delete': { borderTop: `2px solid ${diffColor.delBar}` }
})

const CodeSurface = forwardRef<CodeSurfaceHandle, CodeSurfaceProps>(function CodeSurface(
  { value, editable, onDocChange, onFlush, onSave, regions, ariaLabel, onSelectRegion, onScrollLine },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const editableCompartment = useRef(new Compartment())

  // Props the extensions reach through, so the editor is built once and never
  // rebuilt because a callback identity changed.
  const docChangeRef = useRef(onDocChange)
  docChangeRef.current = onDocChange
  const flushRef = useRef(onFlush)
  flushRef.current = onFlush
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const scrollLineRef = useRef(onScrollLine)
  scrollLineRef.current = onScrollLine
  const selectRegionRef = useRef(onSelectRegion)
  selectRegionRef.current = onSelectRegion
  const editableRef = useRef(editable)
  editableRef.current = editable

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          gutter({
            class: 'cm-region-gutter',
            lineMarker: (current, block) => {
              const state = current.state
              const region = regionAt(state.field(regionsField), state.doc.lineAt(block.from).number)
              return region ? new RegionBar(region, Boolean(selectRegionRef.current)) : null
            },
            lineMarkerChange: (update) => update.startState.field(regionsField) !== update.state.field(regionsField),
            initialSpacer: () => BAR_SPACER,
            domEventHandlers: {
              click: (current, block) => {
                const handler = selectRegionRef.current
                if (!handler) return false
                const state = current.state
                const region = regionAt(state.field(regionsField), state.doc.lineAt(block.from).number)
                if (!region) return false
                handler(region)
                return true
              }
            }
          }),
          regionsField,
          regionHighlight,
          history(),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                saveRef.current?.()
                return true
              }
            },
            ...historyKeymap,
            ...standardKeymap
          ]),
          theme,
          editableCompartment.current.of([
            EditorView.editable.of(editable),
            EditorState.readOnly.of(!editable)
          ]),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            // The cheap facts only. Serialising here is what this whole shape exists
            // to avoid — see `getText`.
            docChangeRef.current?.({ lines: update.state.doc.lines, length: update.state.doc.length })
          })
        ] satisfies Extension[]
      }),
      parent: host
    })
    viewRef.current = view

    // The top visible line, reported per scroll frame without going through React —
    // the caller only stores it so a tab can be reopened where it was left.
    const scroller = view.scrollDOM
    const report = (): void => {
      const handler = scrollLineRef.current
      if (!handler) return
      const box = scroller.getBoundingClientRect()
      handler(view.state.doc.lineAt(view.posAtCoords({ x: box.left + 1, y: box.top + 1 }, false)).number)
    }
    scroller.addEventListener('scroll', report, { passive: true })

    return () => {
      scroller.removeEventListener('scroll', report)
      // Last chance to read the document: after `destroy()` there is nothing to read,
      // and this cleanup runs before the parent's.
      flushRef.current?.(view.state.doc.toString())
      view.destroy()
      viewRef.current = null
    }
    // Built once per mount. `value` seeds the document and is kept in step by the
    // effect below; the rest reach the extensions through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: editableCompartment.current.reconfigure([
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable)
      ])
    })
  }, [editable])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: setRegions.of(regions) })
  }, [regions])

  // Only fires when the caller replaces the document from outside — a disk read,
  // 放弃修改, a restored draft. The editor's own edits never come back through `value`,
  // so there is no echo to guard against; what is guarded is replacing the document
  // with an identical one, which would move the caret and push a bogus undo entry.
  // The length check keeps the string comparison off the common path.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc
    if (doc.length === value.length && doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: doc.length, insert: value } })
  }, [value])

  useImperativeHandle(
    ref,
    () => ({
      revealLine: (line, options) => {
        const view = viewRef.current
        if (!view) return
        const target = Math.min(Math.max(line, 1), view.state.doc.lines)
        const info = view.state.doc.line(target)
        view.dispatch({
          ...(options?.select ? { selection: { anchor: info.from, head: info.to } } : {}),
          effects: EditorView.scrollIntoView(info.from, { y: options?.align === 'top' ? 'start' : 'center' })
        })
        if (options?.select) view.focus()
      },
      currentLine: () => {
        const view = viewRef.current
        if (!view) return 1
        if (editableRef.current) return view.state.doc.lineAt(view.state.selection.main.head).number
        // Read-only surfaces have no caret, so "where you are" is the middle of the
        // viewport — the same point `revealLine` scrolls a line to, which is what lets
        // change navigation step forward instead of re-finding the current change.
        const box = view.scrollDOM.getBoundingClientRect()
        const middle = view.posAtCoords({ x: box.left + 1, y: box.top + box.height / 2 }, false)
        return view.state.doc.lineAt(middle).number
      },
      focus: () => {
        viewRef.current?.focus()
      },
      getText: () => viewRef.current?.state.doc.toString() ?? ''
    }),
    []
  )

  return (
    <div
      ref={hostRef}
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        background: color.surface,
        border: `1px solid ${color.line}`,
        borderRadius: radius.r2
      }}
    />
  )
})

export default CodeSurface
