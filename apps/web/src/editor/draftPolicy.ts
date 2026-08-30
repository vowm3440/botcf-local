/** When an editor buffer counts as unsaved, and when it is worth serialising.
 *
 *  Pure on purpose. The editor owns the document now (editor/CodeSurface.tsx), and
 *  asking it for the text costs a full ~948 KB serialise on the files this editor is
 *  meant to survive — so *when* the viewer asks became a decision with consequences,
 *  and a decision with consequences should be testable without a DOM. `apps/web/test`
 *  has no browser environment, and CodeMirror in jsdom measures every element as zero
 *  pixels, so a component test of this would be testing the stub. These functions are
 *  the part worth pinning down; the wiring around them is covered by the perf gate. */

export interface BufferShape {
  /** Characters in the editor's document. */
  length: number
  /** Lines in it, for the meta line and nothing else. */
  lines: number
}

/** Is the buffer different from the snapshot last read off disk?
 *
 *  `readText` is only called when the two lengths agree, which during ordinary typing
 *  never happens — every insertion and deletion changes the length. It is the
 *  replace-a-selection and undo-back-to-the-original cases that land here, and those
 *  are worth one comparison to get right: a ● that will not clear after an undo is a
 *  lie about unsaved work.
 *
 *  It returns `null` when there is no live buffer to read — no editor mounted and
 *  nothing cached — and that case is deliberately *not* an empty string. Conflating
 *  the two is a real bug this signature exists to prevent: the viewer unmounts its
 *  editor in the 内联 and 差异 views, so a file the assistant changed (which opens in
 *  内联) had no editor to ask, answered `''`, compared that to a non-empty file and
 *  declared itself unsaved. The ● was the visible half; the invisible half was the
 *  draft cache then storing that empty buffer, so reopening the tab seeded the editor
 *  with nothing and one Ctrl+S would have written it to disk. No buffer means the
 *  buffer *is* the snapshot. */
export function isDirty(shape: BufferShape, diskContent: string, readText: () => string | null): boolean {
  if (shape.length !== diskContent.length) return true
  const text = readText()
  return text !== null && text !== diskContent
}

export type DraftAction =
  /** Nothing to record, and nothing recorded. */
  | { kind: 'none' }
  /** Drop the cached buffer: it matches disk, or the file is gone. */
  | { kind: 'clear' }
  /** Serialise and cache. */
  | { kind: 'write' }

/** What the draft cache needs doing after a change.
 *
 *  Writing on every keystroke is what the editor's whole shape now avoids, but the
 *  cache cannot simply wait for the viewer to unmount either: the ● marker and the
 *  tab-eviction keep-set both read it, and both have to be right from the first
 *  keystroke. So the entry is created once, when the buffer first diverges from disk,
 *  and its *content* is refreshed only when something will actually read it — the
 *  viewer's flush on the way out (editor/CodeSurface.tsx `onFlush`), or a save.
 *
 *  Staleness in between has no reader: the only consumer of the stored content is a
 *  remount, and an unmount always runs first. */
export function draftAction(dirty: boolean, alreadyCached: boolean): DraftAction {
  if (!dirty) return alreadyCached ? { kind: 'clear' } : { kind: 'none' }
  return alreadyCached ? { kind: 'none' } : { kind: 'write' }
}
