'use strict'

/** A session diff for a file that already exists, built out of that file's own lines.
 *
 *  Both harnesses need the app to be showing what the assistant changed, and neither
 *  can get there the way the app does. Diffs reach the UI on one path only — OMP
 *  reports a tool call, `routes/chat.ts` folds it into the turn's `files_changed`
 *  summary, `useChatSession` merges that into `changedFiles`, and `FileViewer` reads
 *  its `diff` prop from there — and OMP is not running: the gate points the updater at
 *  a dead proxy precisely so no agent binary is installed mid-run. So 「内联」 and 「差异」
 *  were unreachable in every harness, and the change bars, the gutter markers and the
 *  windowed inline view had no coverage at all.
 *
 *  What a harness fakes is the *upstream*, never the app. The driver stubs `fetch` for
 *  `/api/chat/stream` alone and answers it with the SSE frames a finished turn emits;
 *  everything downstream of that byte stream is the real thing, parsed by the real
 *  `streamChat`. This module builds the payload for that answer.
 *
 *  The `+` lines are the file's *real* current lines, which is not a detail:
 *  `anchorRegions` re-finds each region by content and drops any block it cannot
 *  locate, so a diff whose additions do not exist on disk would silently anchor to
 *  nothing and the harness would measure an empty view while reporting success. */

/** Unchanged lines either side of a change in the generated hunks. Two rather than
 *  git's three only to keep a many-region diff under the app's own DIFF_CAP
 *  (apps/web/src/chat/changedFiles.ts) — a truncated diff is a different fixture from
 *  the one the harness thinks it wrote. It does not affect what the inline view shows:
 *  that uses its own context window (DEFAULT_INLINE_CONTEXT). */
const DEFAULT_CONTEXT = 2

/** Mirrors DIFF_CAP in apps/web/src/chat/changedFiles.ts. Asserted, not assumed. */
const DIFF_CAP = 200_000

/** One change to describe.
 *
 *  `kind` is the region kind the app will derive, and all three are here because all
 *  three draw differently: an addition gets a green band, a rewrite a blue one, and a
 *  deletion occupies no line at all — it is a rule on the boundary above the line that
 *  now sits where the removed text was. A harness that only ever produced 'modify'
 *  would leave two of the three untested.
 *
 *  @typedef {{ line: number, kind?: 'modify' | 'add' | 'delete', removed?: string[] }} Edit */

function removedTextFor(edit, index) {
  if (edit.removed) return edit.removed
  if (edit.kind === 'add') return []
  return [`export const removed_${index}_${edit.line} = { id: ${edit.line} }`]
}

function addedTextFor(edit, lines) {
  if (edit.kind === 'delete') return []
  const text = lines[edit.line - 1]
  if (text === undefined) throw new Error(`session diff: 第 ${edit.line} 行不在文件里(共 ${lines.length} 行)`)
  return [text]
}

/** Build a unified diff for `lines`, describing `edits` as if an agent had just made
 *  them. Line numbers on the new side are true; the old side is a consistent running
 *  count, which is what a real diff would carry and what makes this readable in the
 *  「差异」 tab. */
function buildSessionDiff(displayPath, lines, edits, options = {}) {
  const context = Math.max(0, options.context ?? DEFAULT_CONTEXT)
  const cap = options.cap ?? DIFF_CAP
  const sorted = [...edits].sort((left, right) => left.line - right.line)
  const out = [`diff --git a/${displayPath} b/${displayPath}`, `--- a/${displayPath}`, `+++ b/${displayPath}`]
  /** New-side minus old-side line count so far, so the old numbers stay consistent. */
  let shift = 0

  sorted.forEach((edit, index) => {
    const removed = removedTextFor(edit, index)
    const added = addedTextFor(edit, lines)
    const before = []
    for (let line = Math.max(1, edit.line - context); line < edit.line; line++) before.push(lines[line - 1])
    const after = []
    // A deletion occupies no new line, so the line at `edit.line` is context for it;
    // for the other two kinds that line is the change itself.
    const firstAfter = edit.kind === 'delete' ? edit.line : edit.line + added.length
    for (let line = firstAfter; line < firstAfter + context && line <= lines.length; line++) after.push(lines[line - 1])

    const newStart = Math.max(1, edit.line - before.length)
    const oldStart = Math.max(1, newStart - shift)
    const newCount = before.length + added.length + after.length
    const oldCount = before.length + removed.length + after.length
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const text of before) out.push(` ${text}`)
    for (const text of removed) out.push(`-${text}`)
    for (const text of added) out.push(`+${text}`)
    for (const text of after) out.push(` ${text}`)
    shift += added.length - removed.length
  })

  const diff = out.join('\n') + '\n'
  // The load is the harness's independent variable: assert it rather than discovering
  // later that the app quietly kept only the tail of it.
  if (diff.length > cap) {
    throw new Error(`session diff ${displayPath}: ${diff.length} 字符,超过 DIFF_CAP ${cap} —— 会被截断,请减少改动数量`)
  }
  return diff
}

/** Evenly spaced single-line rewrites through a file — the load shape, as opposed to
 *  the correctness shape. `count` regions at `spacing` apart, kept clear of both ends
 *  so every one of them has full context. */
function spreadEdits(lineCount, count, options = {}) {
  const context = options.context ?? DEFAULT_CONTEXT
  const margin = context + 1
  const usable = lineCount - 2 * margin
  if (count < 1 || usable < count) throw new Error(`spreadEdits: ${count} 处改动放不进 ${lineCount} 行`)
  const spacing = Math.floor(usable / count)
  // Regions closer together than the inline view's context window would merge into
  // one, so the row count would stop being count × window and the fixture would no
  // longer be the one it claims to be.
  if (spacing < 8) throw new Error(`spreadEdits: 间距 ${spacing} 行过密,区域会被合并`)
  return Array.from({ length: count }, (_, index) => ({ line: margin + index * spacing, kind: 'modify' }))
}

/** What the app should end up reporting for these edits: the totals the 「AI +N −M
 *  · K 处」 chip shows once the regions have been anchored. Derived from the same
 *  descriptors the diff is built from, so an assertion cannot drift from the fixture
 *  it is asserting. */
function countEdits(edits) {
  let added = 0
  let removed = 0
  edits.forEach((edit, index) => {
    added += addedCountFor(edit)
    removed += removedTextFor(edit, index).length
  })
  return { added, removed, regions: edits.length }
}

function addedCountFor(edit) {
  return edit.kind === 'delete' ? 0 : 1
}

/** The `files_changed` entry a finished turn carries for one file. */
function changedFile(displayPath, diff, tool = 'edit_file') {
  return {
    path: displayPath,
    tools: [tool],
    lastToolCallId: `harness-${displayPath}`,
    hasDiff: true,
    isError: false,
    diff
  }
}

module.exports = { DEFAULT_CONTEXT, DIFF_CAP, buildSessionDiff, spreadEdits, countEdits, changedFile }
