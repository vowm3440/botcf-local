import { describe, expect, it } from 'vitest'
import { edgeRect, frameEdgeAt, insertionBefore, zoneAt } from '../src/dock/dockGeometry'

/** Drop geometry decides what a gesture means, and getting it wrong is the fastest
 *  way to make a dock feel arbitrary. The cases that matter are the awkward shapes:
 *  a short wide panel, a narrow column, a corner. */

const pane = { left: 0, top: 0, width: 800, height: 600 }
/** A bottom panel: the shape a fraction-based edge band gets wrong. */
const strip = { left: 0, top: 420, width: 1200, height: 180 }

describe('zoneAt', () => {
  it('reads the middle of a pane as the middle', () => {
    expect(zoneAt(400, 300, pane)).toBe('center')
  })

  it('reads each edge band as that edge', () => {
    expect(zoneAt(12, 300, pane)).toBe('left')
    expect(zoneAt(792, 300, pane)).toBe('right')
    expect(zoneAt(400, 8, pane)).toBe('top')
    expect(zoneAt(400, 594, pane)).toBe('bottom')
  })

  it('leaves a short wide strip with a centre big enough to hit', () => {
    // A quarter of 1200px would be a 300px "left edge" on a panel this shape.
    expect(zoneAt(250, 510, strip)).toBe('center')
    expect(zoneAt(20, 510, strip)).toBe('left')
    expect(zoneAt(600, 596, strip)).toBe('bottom')
  })

  it('still allows edge drops on a pane too small for full bands', () => {
    const small = { left: 0, top: 0, width: 100, height: 100 }
    expect(zoneAt(10, 50, small)).toBe('left')
    expect(zoneAt(50, 50, small)).toBe('center')
  })

  it('survives a pane with no area rather than dividing by zero', () => {
    expect(zoneAt(0, 0, { left: 0, top: 0, width: 0, height: 0 })).toBe('left')
  })
})

describe('edgeRect', () => {
  it('slices the share off the named edge', () => {
    expect(edgeRect(pane, 'left', 0.5)).toEqual({ left: 0, top: 0, width: 400, height: 600 })
    expect(edgeRect(pane, 'right', 0.5)).toEqual({ left: 400, top: 0, width: 400, height: 600 })
    expect(edgeRect(pane, 'top', 0.25)).toEqual({ left: 0, top: 0, width: 800, height: 150 })
    expect(edgeRect(pane, 'bottom', 0.25)).toEqual({ left: 0, top: 450, width: 800, height: 150 })
  })

  it('keeps the pane origin it was given', () => {
    expect(edgeRect(strip, 'bottom', 0.5)).toEqual({ left: 0, top: 510, width: 1200, height: 90 })
  })
})

describe('frameEdgeAt', () => {
  const frame = { left: 0, top: 0, width: 1000, height: 800 }

  it('is null anywhere but the outer ring', () => {
    expect(frameEdgeAt(500, 400, frame)).toBeNull()
    expect(frameEdgeAt(-5, 400, frame)).toBeNull()
    expect(frameEdgeAt(500, 900, frame)).toBeNull()
  })

  it('names the edge the pointer is hugging', () => {
    expect(frameEdgeAt(8, 400, frame)).toBe('left')
    expect(frameEdgeAt(996, 400, frame)).toBe('right')
    expect(frameEdgeAt(500, 2, frame)).toBe('top')
    expect(frameEdgeAt(500, 798, frame)).toBe('bottom')
  })

  it('resolves a corner to the nearer edge', () => {
    expect(frameEdgeAt(4, 20, frame)).toBe('left')
    expect(frameEdgeAt(20, 4, frame)).toBe('top')
  })
})

describe('insertionBefore', () => {
  const tabs = [
    { id: 'a', left: 0, width: 50 },
    { id: 'b', left: 50, width: 50 },
    { id: 'c', left: 100, width: 50 }
  ]

  it('flips at each tab’s midpoint', () => {
    expect(insertionBefore(tabs, 20)).toBe('a')
    expect(insertionBefore(tabs, 30)).toBe('b')
    expect(insertionBefore(tabs, 80)).toBe('c')
  })

  it('past the last midpoint means last', () => {
    expect(insertionBefore(tabs, 140)).toBeNull()
    expect(insertionBefore([], 10)).toBeNull()
  })
})
