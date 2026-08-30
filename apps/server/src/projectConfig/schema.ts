import { SAFE_SCRIPT_NAME } from '../preview/projectDetect.js'
import { isShellKind, type ShellKind } from '../terminal/shell.js'

/** Schema for the per-project config file (`.botcf/config.json`).
 *
 *  The file lives *inside* the project, so it is untrusted input in exactly the
 *  same way the project's own `package.json` is: it may declare tasks, but it can
 *  never widen what the app is allowed to do. Hence the rules below —
 *   - a task names either a package.json script or an explicit argv, and every
 *     argv token must match a conservative charset (no spaces, no shell
 *     metacharacters), because Windows needs a shell to reach `npm.cmd`;
 *   - the terminal may only *pick* one of the known shells, never supply a path;
 *   - environment additions are bounded in count, key shape and value length;
 *   - nothing here starts anything: a task only ever runs when the user clicks it.
 *
 *  Parsing never throws. A malformed entry is dropped with a warning the UI shows,
 *  so one bad line cannot make the whole project unusable. */

export type TaskKind = 'build' | 'run' | 'test' | 'lint' | 'custom'

export const TASK_KINDS: readonly TaskKind[] = ['build', 'run', 'test', 'lint', 'custom']

export interface ProjectTaskConfig {
  name: string
  kind: TaskKind
  /** package.json script name; ignored when `command` is present. */
  script?: string
  /** Explicit argv, token 0 being the executable. */
  command?: string[]
  /** Root-relative subdirectory to run in. */
  cwd?: string
  env?: Record<string, string>
  /** Long-running work (a dev server): the panel does not wait for an exit. */
  background?: boolean
}

export interface ProjectConfig {
  version: 1
  tasks: ProjectTaskConfig[]
  /** Also derive tasks from package.json scripts (build/test/lint/dev names). */
  discoverScripts: boolean
  preview: {
    mode: 'auto' | 'static' | 'command'
    script: string | null
  }
  terminal: {
    shell: ShellKind | null
    env: Record<string, string>
  }
  review: {
    /** Stage a file automatically once its diff has been reviewed and accepted. */
    stageOnAccept: boolean
    /** Commit message template; `{files}` and `{count}` are substituted. */
    commitTemplate: string
  }
}

export const MAX_TASKS = 40
export const MAX_TASK_NAME_CHARS = 60
export const MAX_COMMAND_TOKENS = 16
export const MAX_TOKEN_CHARS = 200
export const MAX_ENV_ENTRIES = 20
export const MAX_ENV_VALUE_CHARS = 1_000

/** Argv tokens are joined into a command line by the shell on Windows, so the
 *  charset excludes whitespace and every metacharacter. */
export const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9_@:.,=+~/\\-]+$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export const DEFAULT_COMMIT_TEMPLATE = 'chore: 应用 AI 修改 ({count} 个文件)'

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  version: 1,
  tasks: [],
  discoverScripts: true,
  preview: { mode: 'auto', script: null },
  terminal: { shell: null, env: {} },
  review: { stageOnAccept: true, commitTemplate: DEFAULT_COMMIT_TEMPLATE }
}

interface ParseContext {
  warnings: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function parseEnv(raw: unknown, context: ParseContext, where: string): Record<string, string> {
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    context.warnings.push(`${where}: env 必须是对象,已忽略`)
    return {}
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(env).length >= MAX_ENV_ENTRIES) {
      context.warnings.push(`${where}: env 最多 ${MAX_ENV_ENTRIES} 项,多余的已忽略`)
      break
    }
    if (!ENV_KEY.test(key)) {
      context.warnings.push(`${where}: 环境变量名 ${key.slice(0, 40)} 不合法,已忽略`)
      continue
    }
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE_CHARS || /[\0\r\n]/.test(value)) {
      context.warnings.push(`${where}: 环境变量 ${key} 的值不合法,已忽略`)
      continue
    }
    env[key] = value
  }
  return env
}

/** Root-relative subdirectory, rejected outright when it tries to walk out. */
function parseCwd(raw: unknown, context: ParseContext, where: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') {
    context.warnings.push(`${where}: cwd 必须是字符串,已忽略`)
    return null
  }
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (normalized === '') return null
  if (normalized.split('/').some((segment) => segment === '..') || /^[A-Za-z]:/.test(normalized)) {
    context.warnings.push(`${where}: cwd 必须是目录内的相对路径,已忽略`)
    return null
  }
  return normalized
}

function parseCommand(raw: unknown, context: ParseContext, where: string): string[] | null {
  if (raw === undefined) return null
  if (!Array.isArray(raw) || raw.length === 0) {
    context.warnings.push(`${where}: command 必须是非空字符串数组,已忽略`)
    return null
  }
  if (raw.length > MAX_COMMAND_TOKENS) {
    context.warnings.push(`${where}: command 最多 ${MAX_COMMAND_TOKENS} 个参数,已忽略`)
    return null
  }
  const tokens: string[] = []
  for (const token of raw) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
      context.warnings.push(`${where}: command 参数必须是 1-${MAX_TOKEN_CHARS} 字符的字符串,已忽略该任务`)
      return null
    }
    if (!SAFE_COMMAND_TOKEN.test(token)) {
      context.warnings.push(`${where}: command 参数 ${token.slice(0, 40)} 含有不允许的字符(空格与 shell 元字符),已忽略该任务`)
      return null
    }
    tokens.push(token)
  }
  return tokens
}

function parseTask(raw: unknown, index: number, context: ParseContext): ProjectTaskConfig | null {
  const where = `tasks[${index}]`
  if (!isRecord(raw)) {
    context.warnings.push(`${where}: 必须是对象,已忽略`)
    return null
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || name.length > MAX_TASK_NAME_CHARS || /[\0\r\n]/.test(name)) {
    context.warnings.push(`${where}: name 必须是 1-${MAX_TASK_NAME_CHARS} 字符的文本,已忽略`)
    return null
  }
  const kind = TASK_KINDS.includes(raw.kind as TaskKind) ? (raw.kind as TaskKind) : 'custom'
  if (raw.kind !== undefined && kind === 'custom' && raw.kind !== 'custom') {
    context.warnings.push(`${where}: kind ${String(raw.kind).slice(0, 20)} 未知,按 custom 处理`)
  }
  const command = parseCommand(raw.command, context, where)
  const script = typeof raw.script === 'string' && SAFE_SCRIPT_NAME.test(raw.script.trim()) ? raw.script.trim() : null
  if (raw.script !== undefined && !script) {
    context.warnings.push(`${where}: script 名称不合法(只允许字母、数字和 :_.-),已忽略`)
  }
  if (!command && !script) {
    context.warnings.push(`${where}: 需要 script 或 command 之一,已忽略`)
    return null
  }
  if (command && script) {
    context.warnings.push(`${where}: 同时给了 script 与 command,按 command 执行`)
  }
  const cwd = parseCwd(raw.cwd, context, where)
  const env = parseEnv(raw.env, context, where)
  return {
    name,
    kind,
    ...(command ? { command } : { script: script as string }),
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(raw.background === true ? { background: true } : {})
  }
}

function parseTasks(raw: unknown, context: ParseContext): ProjectTaskConfig[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    context.warnings.push('tasks 必须是数组,已忽略')
    return []
  }
  const tasks: ProjectTaskConfig[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    if (tasks.length >= MAX_TASKS) {
      context.warnings.push(`最多 ${MAX_TASKS} 个任务,多余的已忽略`)
      break
    }
    const task = parseTask(entry, index, context)
    if (!task) continue
    const key = task.name.toLowerCase()
    if (seen.has(key)) {
      context.warnings.push(`tasks[${index}]: 任务名 ${task.name} 重复,已忽略后一个`)
      continue
    }
    seen.add(key)
    tasks.push(task)
  }
  return tasks
}

function parsePreview(raw: unknown, context: ParseContext): ProjectConfig['preview'] {
  if (raw === undefined) return DEFAULT_PROJECT_CONFIG.preview
  if (!isRecord(raw)) {
    context.warnings.push('preview 必须是对象,已忽略')
    return DEFAULT_PROJECT_CONFIG.preview
  }
  const mode = raw.mode === 'static' || raw.mode === 'command' || raw.mode === 'auto' ? raw.mode : 'auto'
  if (raw.mode !== undefined && mode === 'auto' && raw.mode !== 'auto') {
    context.warnings.push('preview.mode 必须是 auto/static/command,按 auto 处理')
  }
  const script = typeof raw.script === 'string' && SAFE_SCRIPT_NAME.test(raw.script.trim()) ? raw.script.trim() : null
  if (raw.script !== undefined && raw.script !== null && !script) {
    context.warnings.push('preview.script 名称不合法,已忽略')
  }
  return { mode, script }
}

function parseTerminal(raw: unknown, context: ParseContext): ProjectConfig['terminal'] {
  if (raw === undefined) return { shell: null, env: {} }
  if (!isRecord(raw)) {
    context.warnings.push('terminal 必须是对象,已忽略')
    return { shell: null, env: {} }
  }
  let shell: ShellKind | null = null
  if (raw.shell !== undefined && raw.shell !== null) {
    if (isShellKind(raw.shell)) shell = raw.shell
    else context.warnings.push('terminal.shell 必须是 powershell/cmd/bash/sh/zsh,已按平台默认处理')
  }
  return { shell, env: parseEnv(raw.env, context, 'terminal') }
}

function parseReview(raw: unknown, context: ParseContext): ProjectConfig['review'] {
  if (raw === undefined) return DEFAULT_PROJECT_CONFIG.review
  if (!isRecord(raw)) {
    context.warnings.push('review 必须是对象,已忽略')
    return DEFAULT_PROJECT_CONFIG.review
  }
  const template =
    typeof raw.commitTemplate === 'string' && raw.commitTemplate.trim() !== '' && raw.commitTemplate.length <= 200
      ? raw.commitTemplate.trim()
      : DEFAULT_COMMIT_TEMPLATE
  if (raw.commitTemplate !== undefined && template === DEFAULT_COMMIT_TEMPLATE && raw.commitTemplate !== DEFAULT_COMMIT_TEMPLATE) {
    context.warnings.push('review.commitTemplate 不合法,已使用默认模板')
  }
  return {
    stageOnAccept: raw.stageOnAccept !== false,
    commitTemplate: template
  }
}

export interface ParsedProjectConfig {
  config: ProjectConfig
  warnings: string[]
}

/** Validate an already-parsed JSON value into a config. */
export function normalizeProjectConfig(raw: unknown): ParsedProjectConfig {
  const context: ParseContext = { warnings: [] }
  if (!isRecord(raw)) {
    return { config: DEFAULT_PROJECT_CONFIG, warnings: ['配置根节点必须是对象,已使用默认配置'] }
  }
  if (raw.version !== undefined && raw.version !== 1) {
    context.warnings.push(`未知的配置版本 ${String(raw.version).slice(0, 20)},按当前版本解析`)
  }
  const config: ProjectConfig = {
    version: 1,
    tasks: parseTasks(raw.tasks, context),
    discoverScripts: raw.discoverScripts !== false,
    preview: parsePreview(raw.preview, context),
    terminal: parseTerminal(raw.terminal, context),
    review: parseReview(raw.review, context)
  }
  return { config, warnings: context.warnings }
}

/** Parse the file's text. Never throws: unreadable JSON degrades to defaults. */
export function parseProjectConfig(text: string | null): ParsedProjectConfig {
  if (text === null || text.trim() === '') return { config: DEFAULT_PROJECT_CONFIG, warnings: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err: unknown) {
    return {
      config: DEFAULT_PROJECT_CONFIG,
      warnings: [`配置不是合法 JSON(${err instanceof Error ? err.message : '解析失败'}),已使用默认配置`]
    }
  }
  return normalizeProjectConfig(parsed)
}

/** Reading and writing are two different contracts, and conflating them is what
 *  let a stray keystroke replace a working config with the defaults.
 *
 *  *Reading* is deliberately forgiving: a project whose `.botcf/config.json` is
 *  broken must still open, so the parse above degrades to defaults with a warning.
 *  *Writing* must not degrade at all — the input is what the user is asking us to
 *  store, so anything we cannot understand is a rejection that leaves the file on
 *  disk untouched, byte for byte. Field-level rejections stay warnings: those name
 *  the entry that was dropped, and the rest of the config is still what was meant. */
export type ProjectConfigCheck = ({ ok: true } & ParsedProjectConfig) | { ok: false; error: string }

export function checkProjectConfig(raw: unknown): ProjectConfigCheck {
  if (!isRecord(raw)) return { ok: false, error: '配置根节点必须是 JSON 对象,原有配置未改动' }
  return { ok: true, ...normalizeProjectConfig(raw) }
}

export function checkProjectConfigText(text: string): ProjectConfigCheck {
  if (text.trim() === '') return { ok: false, error: '配置内容为空;要恢复默认配置请保存 {}' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err: unknown) {
    return { ok: false, error: `配置不是合法 JSON(${err instanceof Error ? err.message : '解析失败'}),原有配置未改动` }
  }
  return checkProjectConfig(parsed)
}

export function serializeProjectConfig(config: ProjectConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** Fill in a commit message from the template. */
export function renderCommitMessage(template: string, files: readonly string[]): string {
  const names = files.map((file) => file.split('/').pop() ?? file)
  return template
    .replace(/\{count\}/g, String(files.length))
    .replace(/\{files\}/g, names.slice(0, 5).join(', ') + (names.length > 5 ? ` 等 ${names.length} 个` : ''))
}
