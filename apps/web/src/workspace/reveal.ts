import { isOutsideWorkspace } from './paths'

/** Which directories the explorer has to open to show a given file.
 *
 *  The tree fetches lazily: only expanded directories are listed, and "expanded" is
 *  literally "present in the `dirs` map". So revealing `web/src/editor/tabs.ts` is a
 *  matter of naming its ancestors — `web`, `web/src`, `web/src/editor` — and loading
 *  the ones that are not open yet, outermost first, since each listing is what proves
 *  the next level exists.
 *
 *  Separator-only string work, like the rest of workspace/paths.ts: the server owns
 *  resolution and containment. Files outside every root have no ancestors here — the
 *  tree cannot show them at all, so revealing one is a no-op rather than an error. */

/** Ancestor directories of a qualified workspace path, outermost first. The file's
 *  own name is not included; the root name is. */
export function ancestorDirsOf(workspacePath: string): string[] {
  if (!workspacePath || isOutsideWorkspace(workspacePath)) return []
  const segments = workspacePath.split('/').filter((segment) => segment !== '')
  if (segments.length <= 1) return []
  const ancestors: string[] = []
  for (let depth = 1; depth < segments.length; depth++) {
    ancestors.push(segments.slice(0, depth).join('/'))
  }
  return ancestors
}

/** The ancestors that still need loading, outermost first. Passing the currently
 *  expanded set keeps a reveal from re-fetching directories already on screen. */
export function missingAncestors(workspacePath: string, expanded: Iterable<string>): string[] {
  const open = expanded instanceof Set ? expanded : new Set(expanded)
  return ancestorDirsOf(workspacePath).filter((dir) => !open.has(dir))
}

/** True when every ancestor is open, i.e. the file's row is rendered and can be
 *  scrolled to. */
export function isRevealed(workspacePath: string, expanded: Iterable<string>): boolean {
  return missingAncestors(workspacePath, expanded).length === 0 && !isOutsideWorkspace(workspacePath) && workspacePath !== ''
}
