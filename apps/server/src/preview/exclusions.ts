/** Per-activity ignore rules (plan §5: 排除规则拆三份配置:搜索、监听、读取).
 *
 *  One activity's exclusions are not another's, so the rules live in three named
 *  sets instead of one global list:
 *   - watch  — the live-preview reload channel. Build outputs and dependencies
 *     are skipped so `npm install` / a dev-server rewrite loop cannot reload the
 *     page; the watcher additionally never *opens* these subtrees on Linux.
 *   - search — a future project-wide search. It keeps VCS/dependency/cache noise
 *     out but deliberately includes build outputs, which are searchable text the
 *     user may actually look for.
 *   - read   — the file tree and bounded file reads. Nothing is excluded: the
 *     listing is non-recursive with an entry cap, so the user decides whether to
 *     expand a `node_modules` directory instead of the app deciding for them.
 *
 *  Consumers that need one behaviour only must import the matching set — never
 *  a union — so a future tightening of `watch` (skip more dirs) cannot silently
 *  change what the file tree shows. */

export interface ExclusionRules {
  /** Directory segments that exclude the whole subtree at any depth. */
  readonly dirSegments: ReadonlySet<string>
  /** Editor scratch/binary noise, matched against the file's own name; null
   *  disables file-name filtering (the read side excludes nothing). */
  readonly filePattern: RegExp | null
}

const WATCH_DIR_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.vite',
  '.idea',
  '.vscode',
  '__pycache__',
  'target',
  'data'
])

/** Editor scratch files: swap files, atomic-save temporaries, lockfiles. */
const SCRATCH_FILE = /(^\.#|~$|\.swp$|\.swx$|\.tmp$|\.crswap$|^4913$|\.DS_Store$)/i

/** Directory segments every activity agrees are noise (VCS, dependency caches,
 *  editor metadata). Build outputs are deliberately missing: search may want
 *  them, and the file tree never reads past one listing. */
const NOISE_DIR_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.idea',
  '.vscode',
  '__pycache__',
  'data'
])

/** The live-preview reload channel: heavy ignore, build outputs included. */
export const WATCH_RULES: ExclusionRules = {
  dirSegments: WATCH_DIR_SEGMENTS,
  filePattern: SCRATCH_FILE
}

/** Reserved for project-wide search: keeps noise out, lets build output in. */
export const SEARCH_RULES: ExclusionRules = {
  dirSegments: NOISE_DIR_SEGMENTS,
  filePattern: SCRATCH_FILE
}

/** The file tree / bounded reads: nothing is excluded at the rules level. The
 *  listing already caps entries; hiding directories from the user is a UI
 *  decision this layer must not make. */
export const READ_RULES: ExclusionRules = {
  dirSegments: new Set<string>(),
  filePattern: null
}

function partsOf(relPath: string): string[] {
  return relPath.split(/[\\/]+/).filter(Boolean)
}

/** True when a worktree-relative file path falls under one activity's rules. */
export function isPathExcluded(relPath: string, rules: ExclusionRules): boolean {
  if (!relPath) return true
  const parts = partsOf(relPath)
  if (parts.length === 0) return true
  if (parts.some((part) => rules.dirSegments.has(part))) return true
  if (rules.filePattern === null) return false
  return rules.filePattern.test(parts[parts.length - 1])
}

/** True when a worktree-relative *directory* falls under one activity's rules.
 *  Only directory segments apply: the scratch-file pattern targets files. */
export function isDirExcluded(relDir: string, rules: ExclusionRules): boolean {
  if (!relDir) return false
  return partsOf(relDir).some((part) => rules.dirSegments.has(part))
}
