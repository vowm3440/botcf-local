import { useCallback, useEffect, useState } from 'react'
import { diagnosticsApi, type DiagnosticsResponse } from '../services/diagnostics'
import { reviewApi } from '../services/review'

/** The counters the workbench chrome shows: an activity-bar badge on 审查, a tab
 *  badge on 问题, and the same numbers again in the status bar.
 *
 *  A problem the user cannot see is a problem they will not fix, so both are
 *  tracked while their parts are closed. Diagnostics arrive on the same pushed
 *  stream the panel uses (cheap, already coalesced server-side); the review count
 *  is refetched when a turn ends, which is the only moment it grows. */

export interface WorkbenchBadges {
  /** Files waiting for a decision, and whether any of them failed to apply. */
  review: { pending: number; failed: number }
  problems: { errors: number; warnings: number }
  refresh: () => void
}

export function useWorkbenchBadges(enabled = true): WorkbenchBadges {
  const [errors, setErrors] = useState(0)
  const [warnings, setWarnings] = useState(0)
  const [pending, setPending] = useState(0)
  const [failed, setFailed] = useState(0)

  const refreshReview = useCallback(() => {
    if (!enabled) return
    reviewApi
      .overview()
      .then((overview) => {
        setPending(overview.summary.pending)
        setFailed(overview.summary.failed)
      })
      .catch(() => undefined)
  }, [enabled])

  useEffect(() => {
    refreshReview()
  }, [refreshReview])

  useEffect(() => {
    if (!enabled) return
    const onTurn = (): void => refreshReview()
    window.addEventListener('botcf:turn-complete', onTurn)
    return () => window.removeEventListener('botcf:turn-complete', onTurn)
  }, [enabled, refreshReview])

  useEffect(() => {
    if (!enabled) return
    const source = new EventSource(diagnosticsApi.eventsUrl())
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as { type?: string } & DiagnosticsResponse
        if (frame.type !== 'diagnostics') return
        setErrors(frame.summary.errors)
        setWarnings(frame.summary.warnings)
      } catch {
        /* ignore malformed frames */
      }
    }
    return () => source.close()
  }, [enabled])

  return {
    review: { pending, failed },
    problems: { errors, warnings },
    refresh: refreshReview
  }
}
