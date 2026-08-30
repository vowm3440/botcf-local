/** Cross-panel signal for project-config changes.
 *
 *  Saving `.botcf/config.json` changes what other panels show — the task list, the
 *  terminal's shell, the review commit template — and those panels do not share a
 *  parent with the config panel. Same pattern as workspace/events.ts. */

export const PROJECT_CONFIG_SAVED_EVENT = 'botcf:project-config-saved'

export function notifyProjectConfigSaved(rootId: string): void {
  window.dispatchEvent(new CustomEvent(PROJECT_CONFIG_SAVED_EVENT, { detail: { rootId } }))
}

/** Subscribe; returns the unsubscribe function for a useEffect cleanup. */
export function onProjectConfigSaved(handler: (rootId: string) => void): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ rootId?: string }>).detail
    handler(detail?.rootId ?? '')
  }
  window.addEventListener(PROJECT_CONFIG_SAVED_EVENT, listener)
  return () => window.removeEventListener(PROJECT_CONFIG_SAVED_EVENT, listener)
}
