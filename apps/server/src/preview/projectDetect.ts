import fs from 'node:fs'
import path from 'node:path'

/** Project sniffing for the live-preview engine. Everything here is a pure
 *  function of the on-disk layout: no process is started, nothing is written.
 *  The result only *suggests* a preview mode — starting one is an explicit user
 *  action, because command mode runs the project's own dev server. */

export type PreviewMode = 'static' | 'command'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export type ProjectKind = 'vite' | 'next' | 'node-script' | 'static' | 'empty'

export interface DetectedProject {
  kind: ProjectKind
  /** Mode the UI preselects. */
  mode: PreviewMode
  /** package.json script to run in command mode, when one exists. */
  script: string | null
  /** Every runnable script name, so the UI can offer a choice. */
  scripts: string[]
  packageManager: PackageManager
  /** Workdir-relative html entry for static mode. */
  entry: string | null
  /** Human-readable reason, shown in the preview panel. */
  reason: string
}

/** Scripts that serve a dev server, most preferred first. */
const DEV_SCRIPTS = ['dev', 'start', 'serve', 'preview', 'dev:web'] as const

/** Candidate static entries, in probe order. */
const HTML_ENTRIES = ['index.html', 'public/index.html', 'src/index.html', 'dist/index.html'] as const

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm']
]

/** Script names are interpolated into a shell command line on Windows, so only
 *  this shape is ever accepted — even after an allowlist check. */
export const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/

interface PackageJson {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

function readJsonFile(file: string): PackageJson | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as PackageJson
  } catch {
    // Missing, unreadable or malformed package.json — treat as "no manifest".
    return null
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function existsAny(dir: string, names: readonly string[]): string | null {
  for (const name of names) {
    if (isFile(path.join(dir, name))) return name
  }
  return null
}

export function detectPackageManager(dir: string): PackageManager {
  for (const [lockfile, manager] of LOCKFILES) {
    if (isFile(path.join(dir, lockfile))) return manager
  }
  return 'npm'
}

/** Runnable script names, filtered to the safe shape and sorted dev-first. */
export function runnableScripts(pkg: PackageJson | null): string[] {
  const scripts = pkg?.scripts
  if (!scripts || typeof scripts !== 'object') return []
  const names = Object.keys(scripts).filter(
    (name) => SAFE_SCRIPT_NAME.test(name) && typeof scripts[name] === 'string' && (scripts[name] as string).trim() !== ''
  )
  const rank = (name: string): number => {
    const index = DEV_SCRIPTS.indexOf(name as (typeof DEV_SCRIPTS)[number])
    return index >= 0 ? index : DEV_SCRIPTS.length
  }
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

function hasDependency(pkg: PackageJson | null, name: string): boolean {
  return Boolean(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name])
}

function classifyKind(dir: string, pkg: PackageJson | null, entry: string | null): ProjectKind {
  if (hasDependency(pkg, 'next')) return 'next'
  if (hasDependency(pkg, 'vite') || existsAny(dir, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'])) return 'vite'
  if (runnableScripts(pkg).length > 0) return 'node-script'
  if (entry) return 'static'
  return 'empty'
}

/** Decide how a directory can be previewed. `command` is only suggested when a
 *  dev-shaped script actually exists; otherwise the built-in static host wins,
 *  since it needs no project dependencies at all. */
export function detectProject(dir: string): DetectedProject {
  const pkg = readJsonFile(path.join(dir, 'package.json'))
  const scripts = runnableScripts(pkg)
  const entry = existsAny(dir, HTML_ENTRIES)
  const kind = classifyKind(dir, pkg, entry)
  const script = scripts.find((name) => DEV_SCRIPTS.includes(name as (typeof DEV_SCRIPTS)[number])) ?? scripts[0] ?? null
  const packageManager = detectPackageManager(dir)

  if (script) {
    return {
      kind,
      mode: 'command',
      script,
      scripts,
      packageManager,
      entry,
      reason: `检测到 ${kind === 'empty' ? 'Node' : kind} 项目,可运行 ${packageManager} run ${script}(自带 HMR)`
    }
  }
  if (entry) {
    return {
      kind,
      mode: 'static',
      script: null,
      scripts,
      packageManager,
      entry,
      reason: `检测到静态站点入口 ${entry},使用内置静态服务器 + 文件监听热重载`
    }
  }
  return {
    kind: 'empty',
    mode: 'static',
    script: null,
    scripts,
    packageManager,
    entry: null,
    reason: '未检测到 index.html 或 dev 脚本,静态模式会显示目录索引'
  }
}

/** Build the argv for a package-manager script run. Callers must have validated
 *  the script name against the project's own script list first. */
export function scriptCommand(packageManager: PackageManager, script: string): { file: string; args: string[] } {
  if (!SAFE_SCRIPT_NAME.test(script)) {
    throw new Error(`非法脚本名: ${script.slice(0, 40)}`)
  }
  return { file: packageManager, args: ['run', script] }
}
