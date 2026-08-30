import { useCallback, useEffect, useState } from 'react'
import {
  ALL_HIDDEN,
  parseStoredVisibility,
  serializeVisibility,
  setPanel,
  togglePanel,
  type IdePanelId,
  type PanelVisibility
} from './panelVisibility'

/** React binding for panel visibility: the pure model plus localStorage, so the
 *  panels a user works with are still open after a reload. */

export interface PanelToggles {
  visibility: PanelVisibility
  isVisible: (id: IdePanelId) => boolean
  toggle: (id: IdePanelId) => void
  show: (id: IdePanelId) => void
  hide: (id: IdePanelId) => void
}

function load(storageKey: string): PanelVisibility {
  try {
    return parseStoredVisibility(localStorage.getItem(storageKey))
  } catch {
    // Storage disabled (private mode) — start with everything closed.
    return ALL_HIDDEN
  }
}

export function usePanelToggles(storageKey: string): PanelToggles {
  const [visibility, setVisibility] = useState<PanelVisibility>(() => load(storageKey))

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, serializeVisibility(visibility))
    } catch {
      // Storage unavailable — toggles still work for this session.
    }
  }, [storageKey, visibility])

  const toggle = useCallback((id: IdePanelId) => setVisibility((prev) => togglePanel(prev, id)), [])
  const show = useCallback((id: IdePanelId) => setVisibility((prev) => setPanel(prev, id, true)), [])
  const hide = useCallback((id: IdePanelId) => setVisibility((prev) => setPanel(prev, id, false)), [])
  const isVisible = useCallback((id: IdePanelId) => visibility[id], [visibility])

  return { visibility, isVisible, toggle, show, hide }
}
