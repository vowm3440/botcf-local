/** Pure helpers for qualified workspace paths, the single string form the file
 *  APIs speak: `<rootName>/<relative>`, with the empty string meaning "the
 *  workspace itself" (its list of roots).
 *
 *  A path the server could not attribute to any root stays absolute — those files
 *  are reachable by the agent but not by the file panel, so the UI must be able
 *  to recognise and skip them. Everything here is separator-only string work:
 *  the server owns resolution and containment. */

/** True for a path outside every workspace root (POSIX or Windows absolute). */
export function isOutsideWorkspace(workspacePath: string): boolean {
  return workspacePath.startsWith('/') || /^[a-zA-Z]:\//.test(workspacePath)
}

/** Leading root-name segment, or '' for the workspace root / an absolute path. */
export function rootNameOf(workspacePath: string): string {
  if (!workspacePath || isOutsideWorkspace(workspacePath)) return ''
  return workspacePath.split('/')[0] ?? ''
}

/** Path relative to its root, i.e. everything after the root name. */
export function relativeOf(workspacePath: string): string {
  if (!workspacePath || isOutsideWorkspace(workspacePath)) return ''
  return workspacePath.split('/').slice(1).join('/')
}

export function joinWorkspacePath(rootName: string, relative: string): string {
  const rel = relative.replace(/^\/+|\/+$/g, '')
  return rel ? `${rootName}/${rel}` : rootName
}

/** True when `workspacePath` is `prefix` itself or sits underneath it. Used to
 *  mark a collapsed directory that contains changed files. */
export function isUnderWorkspacePath(workspacePath: string, prefix: string): boolean {
  if (prefix === '') return true
  return workspacePath === prefix || workspacePath.startsWith(`${prefix}/`)
}

/** Changed paths grouped by their root, in first-seen order, so a per-root
 *  summary can be rendered without re-deriving names in the view. */
export function groupByRoot(workspacePaths: readonly string[]): Array<{ rootName: string; paths: string[] }> {
  const groups = new Map<string, string[]>()
  for (const workspacePath of workspacePaths) {
    // Absolute (out-of-workspace) paths group under '' — the view labels them.
    const key = rootNameOf(workspacePath)
    const existing = groups.get(key)
    if (existing) existing.push(workspacePath)
    else groups.set(key, [workspacePath])
  }
  return [...groups.entries()].map(([rootName, paths]) => ({ rootName, paths }))
}
