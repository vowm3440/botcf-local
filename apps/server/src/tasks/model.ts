import type { ProjectConfig, ProjectTaskConfig, TaskKind } from '../projectConfig/schema.js'
import { scriptCommand, type PackageManager } from '../preview/projectDetect.js'

/** Task resolution: the one place that decides what "build / run / test" means
 *  for a project directory.
 *
 *  Two sources, in this order:
 *   1. `.botcf/config.json` — explicit tasks, already validated by the config
 *      schema (safe argv tokens, known kinds, bounded env);
 *   2. `package.json` scripts — discovered automatically and classified by name,
 *      so a project needs no config at all to get a usable task list.
 *
 *  Pure: no filesystem, no spawning. Discovery *describes* runnable work; running
 *  it stays an explicit user action, because a task executes project code. */

export interface TaskDefinition {
  /** Stable within a root, so the UI and the runner agree on identity. */
  id: string
  name: string
  kind: TaskKind
  source: 'config' | 'script'
  /** Executable and arguments as they will be spawned. */
  file: string
  args: string[]
  /** Display form of the command line. */
  commandLine: string
  /** Root-relative working directory; '' means the root itself. */
  cwd: string
  env: Record<string, string>
  /** Long-running work (a dev server): no exit code is expected. */
  background: boolean
}

/** Order tasks are grouped in, and the order the UI renders groups. */
export const TASK_KIND_ORDER: readonly TaskKind[] = ['build', 'run', 'test', 'lint', 'custom']

/** Script-name → kind. Prefix matching catches `build:web`, `test:unit`, … */
const KIND_RULES: Array<[TaskKind, RegExp]> = [
  ['build', /^(build|bundle|compile|dist|package)\b/i],
  ['test', /^(test|tests|coverage|e2e|spec|vitest|jest)\b/i],
  ['lint', /^(lint|typecheck|tsc|check|format|fmt|prettier|eslint|audit)\b/i],
  ['run', /^(dev|start|serve|preview|watch)\b/i]
]

export function classifyScript(script: string): TaskKind {
  const name = script.replace(/[:_-]/g, ':')
  for (const [kind, pattern] of KIND_RULES) {
    if (pattern.test(name)) return kind
  }
  return 'custom'
}

/** Scripts that keep running until stopped. */
export function isBackgroundScript(script: string): boolean {
  return classifyScript(script) === 'run'
}

/** Heavy kinds (build/test) serialize: they take the whole task pool, so a
 *  compile cannot fight a test run for CPU. Kept next to the kind rules so the
 *  scheduler and the UI see the same classification. */
export const HEAVY_TASK_KINDS: ReadonlySet<TaskKind> = new Set(['build', 'test'])

export function isHeavyTask(kind: TaskKind): boolean {
  return HEAVY_TASK_KINDS.has(kind)
}

function definitionFromConfig(task: ProjectTaskConfig, packageManager: PackageManager): TaskDefinition | null {
  const base = {
    id: `config:${task.name}`,
    name: task.name,
    kind: task.kind,
    source: 'config' as const,
    cwd: task.cwd ?? '',
    env: task.env ?? {},
    background: task.background === true
  }
  if (task.command && task.command.length > 0) {
    const [file, ...args] = task.command
    return { ...base, file, args, commandLine: [file, ...args].join(' ') }
  }
  if (!task.script) return null
  try {
    const { file, args } = scriptCommand(packageManager, task.script)
    return { ...base, file, args, commandLine: [file, ...args].join(' ') }
  } catch {
    // The schema already validated the script name; a throw here means the name
    // slipped through, and the task is simply not offered.
    return null
  }
}

function definitionFromScript(script: string, packageManager: PackageManager): TaskDefinition | null {
  try {
    const { file, args } = scriptCommand(packageManager, script)
    return {
      id: `script:${script}`,
      name: script,
      kind: classifyScript(script),
      source: 'script',
      file,
      args,
      commandLine: [file, ...args].join(' '),
      cwd: '',
      env: {},
      background: isBackgroundScript(script)
    }
  } catch {
    return null
  }
}

export interface ResolveTasksInput {
  config: ProjectConfig
  /** Runnable script names from the project's package.json. */
  scripts: readonly string[]
  packageManager: PackageManager
}

/** Config tasks first (the project's own intent), then discovered scripts that
 *  no config task already covers. */
export function resolveTasks({ config, scripts, packageManager }: ResolveTasksInput): TaskDefinition[] {
  const tasks: TaskDefinition[] = []
  const takenNames = new Set<string>()
  const coveredScripts = new Set<string>()

  for (const entry of config.tasks) {
    const definition = definitionFromConfig(entry, packageManager)
    if (!definition) continue
    tasks.push(definition)
    takenNames.add(definition.name.toLowerCase())
    if (entry.script && !entry.command) coveredScripts.add(entry.script)
  }

  if (config.discoverScripts) {
    for (const script of scripts) {
      if (coveredScripts.has(script) || takenNames.has(script.toLowerCase())) continue
      const definition = definitionFromScript(script, packageManager)
      if (!definition) continue
      tasks.push(definition)
      takenNames.add(definition.name.toLowerCase())
    }
  }
  return tasks
}

export function findTask(tasks: readonly TaskDefinition[], id: string): TaskDefinition | null {
  return tasks.find((task) => task.id === id) ?? null
}

/** Group tasks for display, dropping empty groups. */
export function groupTasksByKind(tasks: readonly TaskDefinition[]): Array<{ kind: TaskKind; tasks: TaskDefinition[] }> {
  return TASK_KIND_ORDER.map((kind) => ({ kind, tasks: tasks.filter((task) => task.kind === kind) })).filter(
    (group) => group.tasks.length > 0
  )
}
