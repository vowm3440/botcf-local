import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ModelHealthInfo, type SiteHealthMeta, type SiteModelHealthInfo } from '../../api'

/** Health for the routed model: the site's own last-minutes view plus what this
 *  machine actually measured. Polling follows the interval the site advertises,
 *  and every completed turn refreshes immediately — the local series only moves
 *  when a real request happens, so waiting out the timer looks like a stall. */

const DEFAULT_REFRESH_MS = 15_000

export interface ModelHealth {
  local: ModelHealthInfo | null
  site: SiteModelHealthInfo | null
  siteMeta: SiteHealthMeta | null
}

export function useModelHealth(group: string, model: string): ModelHealth {
  const [health, setHealth] = useState<ModelHealth>({ local: null, site: null, siteMeta: null })
  const refreshMs = useRef(DEFAULT_REFRESH_MS)

  const load = useCallback(async () => {
    if (!group || !model) return
    try {
      const res = await api.modelHealth(group, model)
      setHealth({ local: res.health, site: res.site, siteMeta: res.siteMeta })
      refreshMs.current = res.siteMeta?.refreshMs
        ? Math.max(5_000, Math.min(300_000, res.siteMeta.refreshMs))
        : DEFAULT_REFRESH_MS
    } catch {
      // Health is supplementary; keep the last successful snapshot on errors.
    }
  }, [group, model])

  useEffect(() => {
    let stopped = false
    let timer = 0
    setHealth({ local: null, site: null, siteMeta: null })
    refreshMs.current = DEFAULT_REFRESH_MS
    // No route yet: nothing to ask about, and no timer to leave running.
    if (!group || !model) return

    const poll = async () => {
      await load()
      if (!stopped) timer = window.setTimeout(poll, refreshMs.current)
    }
    poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [group, load, model])

  useEffect(() => {
    const onTurn = () => {
      load()
    }
    window.addEventListener('botcf:turn-complete', onTurn)
    return () => window.removeEventListener('botcf:turn-complete', onTurn)
  }, [load])

  return health
}
