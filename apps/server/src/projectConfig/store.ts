import fs from 'node:fs'
import path from 'node:path'
import { locateInsideRoot } from '../fsContainment.js'
import {
  DEFAULT_PROJECT_CONFIG,
  parseProjectConfig,
  serializeProjectConfig,
  type ProjectConfig
} from './schema.js'

/** Persistence for the per-project config.
 *
 *  The file is `<root>/.botcf/config.json`. Even though its name is fixed,
 *  `.botcf` or the file itself may be a symlink/junction, so both must stay
 *  inside the root. Reads are cached by mtime; a missing file normally yields
 *  the defaults. */

export const CONFIG_DIR_NAME = '.botcf'
export const CONFIG_FILE_NAME = 'config.json'
/** A config file bigger than this is a mistake, not a config. */
const MAX_CONFIG_BYTES = 256 * 1024

export function projectConfigDir(rootPath: string): string {
  return path.join(rootPath, CONFIG_DIR_NAME)
}

export function projectConfigFile(rootPath: string): string {
  return path.join(projectConfigDir(rootPath), CONFIG_FILE_NAME)
}

function assertConfigContained(rootPath: string): void {
  for (const relative of [CONFIG_DIR_NAME, path.join(CONFIG_DIR_NAME, CONFIG_FILE_NAME)]) {
    const located = locateInsideRoot(rootPath, relative)
    if (located.status === 'outside') throw new Error('配置路径越出工作目录')
    // A missing ordinary entry can be created. A dangling link cannot: its
    // eventual write target is not the contained parent used by locate.
    if (located.status === 'missing' && fs.lstatSync(path.join(rootPath, relative), { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('配置路径包含无法解析的符号链接')
    }
  }
}

export interface LoadedProjectConfig {
  file: string
  exists: boolean
  config: ProjectConfig
  /** Validation notes for the UI; an unreadable file also lands here. */
  warnings: string[]
  /** Raw file text, so the config panel can offer the exact source for editing. */
  text: string | null
  mtimeMs: number | null
}

interface CacheEntry {
  mtimeMs: number
  size: number
  loaded: LoadedProjectConfig
}

const cache = new Map<string, CacheEntry>()

function statOrNull(file: string): fs.Stats | null {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

export function loadProjectConfig(rootPath: string): LoadedProjectConfig {
  const file = projectConfigFile(rootPath)
  const stat = statOrNull(file)
  try {
    assertConfigContained(rootPath)
  } catch (err: unknown) {
    cache.delete(file)
    return {
      file,
      exists: stat !== null,
      config: DEFAULT_PROJECT_CONFIG,
      warnings: [err instanceof Error ? err.message : String(err)],
      text: null,
      mtimeMs: stat?.mtimeMs ?? null
    }
  }
  if (!stat) {
    cache.delete(file)
    return { file, exists: false, config: DEFAULT_PROJECT_CONFIG, warnings: [], text: null, mtimeMs: null }
  }
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.loaded
  if (stat.size > MAX_CONFIG_BYTES) {
    const loaded: LoadedProjectConfig = {
      file,
      exists: true,
      config: DEFAULT_PROJECT_CONFIG,
      warnings: [`配置文件超过 ${Math.round(MAX_CONFIG_BYTES / 1024)} KB,已忽略`],
      text: null,
      mtimeMs: stat.mtimeMs
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, loaded })
    return loaded
  }
  let text: string | null = null
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err: unknown) {
    return {
      file,
      exists: true,
      config: DEFAULT_PROJECT_CONFIG,
      warnings: [`配置文件读取失败: ${err instanceof Error ? err.message : String(err)}`],
      text: null,
      mtimeMs: stat.mtimeMs
    }
  }
  const { config, warnings } = parseProjectConfig(text)
  const loaded: LoadedProjectConfig = { file, exists: true, config, warnings, text, mtimeMs: stat.mtimeMs }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, loaded })
  return loaded
}

export type SaveResult =
  | { ok: true; loaded: LoadedProjectConfig }
  | { ok: false; error: string }

/** Write the config back, creating `.botcf/` on first save. The serialized form
 *  is the *normalized* config, so saving a file with rejected entries cleans it
 *  up instead of silently keeping them. */
export function saveProjectConfig(rootPath: string, config: ProjectConfig): SaveResult {
  try {
    assertConfigContained(rootPath)
    fs.mkdirSync(projectConfigDir(rootPath), { recursive: true })
    const file = projectConfigFile(rootPath)
    fs.writeFileSync(file, serializeProjectConfig(config), 'utf8')
    cache.delete(file)
    return { ok: true, loaded: loadProjectConfig(rootPath) }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Test seam: drop memoized reads. */
export function clearProjectConfigCache(): void {
  cache.clear()
}
