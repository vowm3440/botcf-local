/** Disk recovery log client for the editor (plan §4).
 *
 *  draftStore spills an evicted dirty buffer into the byte-bounded in-memory
 *  recovery cache; that cache cannot survive a page reload, so the same payload
 *  is mirrored here to the server, which stores it under
 *  <dataDir>/drafts/<rootId>/<relative path> keyed by the same qualified
 *  workspace path the file panel uses. Reopening a file after a reload asks this
 *  module first; whatever comes back is re-registered as a draft and goes through
 *  the ordinary mtime conflict path on save. */

import { setDraftRecovery, type DraftRecoveryAdapter, type FileDraft } from './draftStore'
import { getJson, postJson, query } from '../services/http'

export interface DraftRecoveryWire {
  success: true
  path: string
  root: { id: string; name: string } | null
  found: boolean
  draft: { content: string; baseMtimeMs: number; savedAt: number } | null
  /** Current on-disk file mtime, for the restore notice. */
  mtimeMs: number | null
  exists: boolean
}

export const draftRecoveryApi = {
  fetch: (path: string) => getJson<DraftRecoveryWire>(`/api/drafts${query({ path })}`),
  persist: (path: string, content: string, baseMtimeMs: number) =>
    postJson<DraftRecoveryWire>('/api/drafts', { path, content, baseMtimeMs }),
  remove: (path: string) => postJson<DraftRecoveryWire>('/api/drafts/delete', { path })
}

const adapter: DraftRecoveryAdapter = {
  fetch: async (path: string) => {
    const wire = await draftRecoveryApi.fetch(path)
    if (!wire.found || !wire.draft) return null
    return { content: wire.draft.content, baseMtimeMs: wire.draft.baseMtimeMs, diskMtimeMs: wire.mtimeMs }
  },
  persist: async (path: string, draft: FileDraft) => {
    await draftRecoveryApi.persist(path, draft.content, draft.baseMtimeMs)
  },
  drop: async (path: string) => {
    await draftRecoveryApi.remove(path)
  }
}

/** Install the disk-backed recovery log. Idempotent; called once at app start,
 *  at module scope so it is in place before any FileViewer mounts. */
export function installDefaultDraftRecovery(): void {
  setDraftRecovery(adapter)
}