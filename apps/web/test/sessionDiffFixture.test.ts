import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { DIFF_CAP as APP_DIFF_CAP } from '../src/chat/changedFiles'
import { hasStaleRegions, parseEditRegions, trackEdits } from '../src/editor/editRegions'
import { FULL_VIEW_LIMIT } from '../src/editor/InlineDiffView'
import { buildInlineRows } from '../src/editor/inlineRows'

/** The harness fixture, checked against the parser it is a fixture for.
 *
 *  `harness/sessionDiff.cjs` writes the unified diff that the perf gate and the
 *  editor E2E deliver as a finished turn, and everything either of them concludes
 *  rests on the app agreeing about what that diff says. That agreement is easy to
 *  lose silently and expensive to notice: `anchorRegions` *drops* any added block it
 *  cannot find in the file, so a generator whose `+` lines drifted from the fixture's
 *  real content would produce a diff the app quietly reduces to nothing — and a
 *  harness measuring an empty view reports a very good number.
 *
 *  So the generator is pinned here rather than trusted: the same functions the app
 *  ships parse it, anchor it and build the inline rows from it, and the totals it
 *  claims are compared against the totals they derive. Nothing in this file needs a
 *  browser, which is why it can live with the other pure tests. */

const require = createRequire(import.meta.url)
// Required rather than imported: the harness is CommonJS, lives outside this
// workspace, and has no reason to grow a build step just to be read by one test.
const { buildSessionDiff, countEdits, spreadEdits, DIFF_CAP } = require('../../../harness/sessionDiff.cjs')
const perfFixture = require('../../../perf/fixture.cjs')

/** Same shape as both fixtures: every line states its own number, so anchoring by
 *  content has something unique to anchor to. */
function document(count: number): string[] {
  const lines = Array.from({ length: count }, (_, index) => `export const line_${String(index + 1).padStart(4, '0')} = { id: ${index + 1} }`)
  // Split the way the viewer does, trailing empty entry included.
  return (lines.join('\n') + '\n').split('\n')
}

const EDITS = [
  { line: 6, kind: 'add' as const },
  { line: 12, kind: 'modify' as const },
  { line: 18, kind: 'delete' as const, removed: ['export const gone_1 = { id: 0 }', 'export const gone_2 = { id: 0 }'] }
]

describe('the harness session diff, read by the app', () => {
  const lines = document(60)
  const diff = buildSessionDiff('root/file.ts', lines, EDITS)
  const tracked = trackEdits(diff, lines)

  it('anchors every region the generator claims to have written', () => {
    // Not "some regions were found": all of them, at the lines they were asked for.
    expect(tracked.regions.map((region) => [region.kind, region.start, region.count])).toEqual([
      ['add', 6, 1],
      ['modify', 12, 1],
      ['delete', 18, 0]
    ])
  })

  it('agrees with the generator about how much changed', () => {
    const claimed = countEdits(EDITS)
    expect({ added: tracked.added, removed: tracked.removed, regions: tracked.regions.length }).toEqual(claimed)
  })

  it('leaves nothing unlocatable, and carries real hunk headers', () => {
    // A dropped block is the failure this whole file exists to catch: the diff would
    // still look fine and the app would show less of it than the harness expects.
    expect(hasStaleRegions(parseEditRegions(diff), tracked)).toBe(false)
    // `approximate` means the line numbers were guessed rather than read from `@@`
    // headers. The generator writes real ones, so a true here is a generator bug.
    expect(tracked.approximate).toBe(false)
  })

  it('puts the removed lines back where they were taken from', () => {
    const rows = buildInlineRows(lines, tracked.regions, { full: false })
    const removed = rows.filter((row) => row.kind === 'removed').map((row) => row.text)
    expect(removed).toHaveLength(tracked.removed)
    // The deletion's own text, in order, is what the inline view has to show in place.
    expect(removed.slice(-2)).toEqual(EDITS[2].removed)
    expect(rows.filter((row) => row.kind === 'added').map((row) => row.line)).toEqual([6, 12])
  })
})

describe('spreadEdits', () => {
  it('keeps every region separate — the row count depends on it', () => {
    const lines = document(4_000)
    const edits = spreadEdits(4_000, 100)
    const tracked = trackEdits(buildSessionDiff('root/big.ts', lines, edits), lines)
    // `mergeRegions` folds anything that touches, so spacing that was too tight
    // would silently give the inline view fewer, larger regions than the fixture
    // says it has — and the gate's row-count expectations with it.
    expect(tracked.regions).toHaveLength(100)
    expect(tracked.added).toBe(100)
  })

  it('refuses a spacing that would merge regions instead of producing one', () => {
    expect(() => spreadEdits(100, 50)).toThrow(/间距/)
  })

  it('refuses more changes than the file has room for', () => {
    expect(() => spreadEdits(20, 100)).toThrow(/放不进/)
  })
})

describe('the diff size guard', () => {
  it('mirrors the cap the app actually applies', () => {
    // `mergeChangedFiles` keeps only the tail past this, so a fixture that crossed it
    // would be a different fixture from the one the harness thinks it wrote.
    expect(DIFF_CAP).toBe(APP_DIFF_CAP)
  })

  it('fails loudly rather than handing over a diff that would be truncated', () => {
    const lines = document(4_000)
    expect(() => buildSessionDiff('root/big.ts', lines, spreadEdits(4_000, 100), { cap: 500 })).toThrow(/DIFF_CAP/)
  })
})

describe('the expandable fixture', () => {
  it('mirrors the line count past which 「显示全文」 is disabled', () => {
    // The perf gate carries a ninth file solely to reach the expanded branch. If this
    // limit moved and the fixture did not, the toggle would be disabled and the
    // branch silently unreachable again — which is the state that made it uncovered
    // in the first place.
    expect(perfFixture.FULL_VIEW_LIMIT).toBe(FULL_VIEW_LIMIT)
    expect(perfFixture.EXPANDABLE_LINES).toBeLessThan(FULL_VIEW_LIMIT)
  })

  it('has enough regions that the collapsed and expanded row counts differ', () => {
    // Collapsed rows follow the changes, expanded rows follow the file. If the two
    // were the same size the expanded check would prove nothing.
    const lines = document(perfFixture.EXPANDABLE_LINES)
    const tracked = trackEdits(
      buildSessionDiff('root/expandable.ts', lines, spreadEdits(perfFixture.EXPANDABLE_LINES, perfFixture.EXPANDABLE_REGIONS)),
      lines
    )
    const collapsed = buildInlineRows(lines, tracked.regions, { full: false }).length
    const expanded = buildInlineRows(lines, tracked.regions, { full: true }).length
    expect(tracked.regions).toHaveLength(perfFixture.EXPANDABLE_REGIONS)
    expect(expanded).toBeGreaterThan(collapsed * 2)
  })
})
