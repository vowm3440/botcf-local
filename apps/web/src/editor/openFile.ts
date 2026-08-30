/** Cross-panel "open this file" request, optionally at a line.
 *
 *  The git panel, the review panel and the diagnostics center all want to hand a
 *  file to the editor, and none of them shares a parent with it. The app already
 *  uses window events for that kind of signal (`botcf:turn-complete`,
 *  `botcf:workspace-changed`), so this follows the pattern: the chat page opens
 *  the tab, and the viewer for that path scrolls to the line. */

export const OPEN_FILE_EVENT = 'botcf:open-file'

export interface OpenFileRequest {
  /** Qualified workspace path (`<rootName>/<relative>`). */
  path: string
  /** 1-based line to reveal, when the caller knows one. */
  line?: number | null
  column?: number | null
  /** False opens the tab in the background. */
  activate?: boolean
}

export function requestOpenFile(request: OpenFileRequest): void {
  window.dispatchEvent(new CustomEvent<OpenFileRequest>(OPEN_FILE_EVENT, { detail: request }))
}

/** Subscribe; returns the unsubscribe function for a useEffect cleanup. */
export function onOpenFileRequest(handler: (request: OpenFileRequest) => void): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<OpenFileRequest>).detail
    if (detail?.path) handler(detail)
  }
  window.addEventListener(OPEN_FILE_EVENT, listener)
  return () => window.removeEventListener(OPEN_FILE_EVENT, listener)
}
