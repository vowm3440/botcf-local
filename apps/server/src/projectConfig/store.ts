import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_PROJECT_CONFIG,
  parseProjectConfig,
  serializeProjectConfig,
  type ProjectConfig
} from './schema.js'

/** Persistence for the per-project config.
 *
 *  The file is `<root>/.botcf/config.json`, a path derived entirely from the
 *  resolved workspace root — never from client input — so there is no path to
 *  contain here. Reads are cached by mtime because the task list, the preview
 *  defaults and the terminal shell are all read on nearly every panel refresh;
 *  a missing file is a normal state that yields the defaults. */

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
