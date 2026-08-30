import { useCallback, useEffect, useState } from 'react'
import { diagnosticsApi, type DiagnosticsResponse } from '../services/diagnostics'
import { reviewApi } from '../services/review'
import type { IdePanelId } from './panelVisibility'

/** Counts shown on the panel toggles.
 *
 *  A problem the user cannot see is a problem they will not fix, so the two
 *  numbers that matter — files waiting for review and outstanding errors — are
 *  tracked even while their panels are closed. Diagnostics arrive on the same
 *  pushed stream the panel uses (cheap, already coalesced server-side); the review
 *  count is refetched when a turn ends, which is the only moment it grows. */

export interface WorkbenchBadges {
  badges: Partial<Record<IdePanelId, number>>
  alerts: Partial<Record<IdePanelId, boolean>>
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
    badges: { review: pending, diagnostics: errors + warnings },
    alerts: { review: failed > 0, diagnostics: errors > 0 },
    refresh: refreshReview
  }
}
