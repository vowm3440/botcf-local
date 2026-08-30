/** Cross-panel signal for workspace mutations.
 *
 *  Adding, removing or re-pointing a root changes what several independent panels
 *  show — the file tree, the top bar's directory status, the preview target and
 *  the editor's open tabs — and those panels do not share a parent that owns the
 *  workspace. The app already uses window events for exactly this kind of
 *  cross-panel signal (`botcf:turn-complete`, `botcf:open-file`). */

export const WORKSPACE_CHANGED_EVENT = 'botcf:workspace-changed'

export function notifyWorkspaceChanged(): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT))
}

/** Subscribe; returns the unsubscribe function for a useEffect cleanup. */
export function onWorkspaceChanged(handler: () => void): () => void {
  window.addEventListener(WORKSPACE_CHANGED_EVENT, handler)
  return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, handler)
}
