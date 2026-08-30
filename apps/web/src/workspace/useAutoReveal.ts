import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { missingAncestors } from './reveal'

/** Keep the explorer pointed at the file the editor is showing.
 *
 *  Two things have to happen and neither is instant: the ancestors of the active file
 *  have to be listed (each fetch is what proves the next level exists, so they go
 *  outermost first), and only then does the row exist to be scrolled to. React commits
 *  in between, so the scroll retries for a few frames rather than assuming the DOM
 *  caught up — a nested path can take several commits to appear.
 *
 *  Reveals supersede each other. Clicking through four AI-changed files in a second
 *  starts four of these, and the last one must win, so each run carries a token and a
 *  stale run stops the moment a newer one begins.
 *
 *  The effect deliberately depends on the active path alone: the expanded set changes
 *  *because* of a reveal, and reacting to that would be a loop. */

export interface AutoRevealOptions {
  /** Qualified workspace path of the file in front, or null. */
  activePath: string | null
  /** False leaves the tree alone; the row is still highlighted where it is. */
  enabled: boolean
  /** Directories currently listed in the tree. */
  expanded: readonly string[]
  /** List one directory; resolves once the tree holds its entries. */
  expand: (dir: string) => Promise<unknown>
  /** The tree's scroll container, whose rows carry `data-path`. */
  containerRef: RefObject<HTMLElement>
}

export interface AutoRevealApi {
  /** Reveal the active file now, whatever the toggle says. */
  reveal: () => void
}

/** Frames a row is waited for before giving up — a truncated listing may never
 *  contain it, and spinning forever on that would be a leak. */
const SCROLL_ATTEMPTS = 12

export function useAutoReveal({ activePath, enabled, expanded, expand, containerRef }: AutoRevealOptions): AutoRevealApi {
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const expandRef = useRef(expand)
  expandRef.current = expand
  /** Bumped by every reveal; a run that no longer owns it stops. */
  const runRef = useRef(0)
  const framesRef = useRef<number[]>([])

  const cancelFrames = useCallback(() => {
    for (const frame of framesRef.current) window.cancelAnimationFrame(frame)
    framesRef.current = []
  }, [])

  const scrollToRow = useCallback(
    (path: string, token: number, attempt = 0) => {
      if (runRef.current !== token) return
      const row = containerRef.current?.querySelector(`[data-path="${cssEscape(path)}"]`)
      if (row) {
        row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        return
      }
      if (attempt >= SCROLL_ATTEMPTS) return
      framesRef.current.push(window.requestAnimationFrame(() => scrollToRow(path, token, attempt + 1)))
    },
    [containerRef]
  )

  const revealPath = useCallback(
    (path: string) => {
      const token = ++runRef.current
      cancelFrames()
      const run = async (): Promise<void> => {
        for (const dir of missingAncestors(path, expandedRef.current)) {
          if (runRef.current !== token) return
          // A directory that fails to list (deleted, or outside the workspace now)
          // ends this reveal quietly: there is nothing to scroll to.
          try {
            await expandRef.current(dir)
          } catch {
            return
          }
        }
        if (runRef.current !== token) return
        scrollToRow(path, token)
      }
      run().catch(() => undefined)
    },
    [cancelFrames, scrollToRow]
  )

  useEffect(() => {
    if (!enabled || !activePath) return
    revealPath(activePath)
  }, [activePath, enabled, revealPath])

  useEffect(() => cancelFrames, [cancelFrames])

  const reveal = useCallback(() => {
    if (activePath) revealPath(activePath)
  }, [activePath, revealPath])

  return { reveal }
}

/** Workspace paths are `<root>/<relative>`, so they can hold characters that mean
 *  something in a selector. `CSS.escape` is not in jsdom, hence the fallback. */
function cssEscape(value: string): string {
  const escaper = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape : null
  return escaper ? escaper(value) : value.replace(/["\\]/g, '\\$&')
}
