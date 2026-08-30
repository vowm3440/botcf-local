import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { diagnosticsCenter, type DiagnosticsCenter } from '../diagnostics/center.js'
import { DiagnosticScanner } from '../diagnostics/parse.js'
import { locateInsideRoot } from '../fsContainment.js'
import { onShutdown } from '../process/shutdown.js'
import type { TaskDefinition } from './model.js'
import { TaskRun, type TaskLogLine, type TaskRunInfo } from './runner.js'

/** The unified task system: build, run and test are one mechanism.
 *
 *  The manager owns run identity and lifetime — one live run per task per root, a
 *  bounded number of concurrent runs, a bounded history of finished runs — and it
 *  is the bridge to the diagnostics center: every output line is scanned, and a
 *  re-run *replaces* its own previous findings instead of piling duplicates up.
 *
 *  Path resolution is injected (`resolvePath`), because only the caller knows the
 *  workspace: the runner prints paths relative to the directory it ran in. */

export const MAX_CONCURRENT_RUNS = 4
export const MAX_RUN_HISTORY = 12

export interface StartTaskInput {
  task: TaskDefinition
  rootId: string
  rootName: string
  /** Absolute root directory; the task's own cwd is resolved inside it. */
  rootPath: string
  /** Tool-printed path → qualified workspace path, for the diagnostics center. */
  resolvePath?: (file: string) => string | null
}

export type StartTaskResult =
  | { ok: true; run: TaskRun }
  | { ok: false; status: number; error: string }

export class TaskManager extends EventEmitter {
  private runs = new Map<string, TaskRun>()
  /** `<rootId>:<taskId>` → run id of the live run, so a task cannot double-start. */
  private activeByTask = new Map<string, string>()
  /** `<rootId>:<taskId>` → run id whose diagnostics a re-run should replace. */
  private lastRunByTask = new Map<string, string>()

  constructor(private readonly center: DiagnosticsCenter = diagnosticsCenter) {
    super()
  }

  list(): TaskRunInfo[] {
    return [...this.runs.values()].map((run) => run.info()).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(runId: string): TaskRun | null {
    return this.runs.get(runId) ?? null
  }

  /** Live run for a task in a root, if any. */
  activeRun(rootId: string, taskId: string): TaskRun | null {
    const runId = this.activeByTask.get(`${rootId}:${taskId}`)
    return runId ? this.runs.get(runId) ?? null : null
  }

  /** Most recent run for a task, finished or not — the verdict the panel shows
   *  next to the task ("last build failed") rather than only "running now". */
  latestRun(rootId: string, taskId: string): TaskRun | null {
    let latest: TaskRun | null = null
    for (const run of this.runs.values()) {
      const info = run.info()
      if (info.rootId !== rootId || info.taskId !== taskId) continue
      if (!latest || info.startedAt > latest.startedAt) latest = run
    }
    return latest
  }

  start(input: StartTaskInput): StartTaskResult {
    const { task, rootId, rootName, rootPath } = input
    const key = `${rootId}:${task.id}`
    const running = this.activeRun(rootId, task.id)
    if (running) return { ok: false, status: 409, error: `任务「${task.name}」正在运行中` }
    if ([...this.runs.values()].filter((run) => run.running).length >= MAX_CONCURRENT_RUNS) {
      return { ok: false, status: 409, error: `同时最多运行 ${MAX_CONCURRENT_RUNS} 个任务,请先停止一个` }
    }
    // The task's cwd comes from the project config, so contain it before use.
    const located = locateInsideRoot(rootPath, task.cwd || '.')
    if (located.status !== 'ok') {
      return { ok: false, status: 400, error: `任务工作目录不可用: ${task.cwd || '.'}` }
    }
    try {
      if (!fs.statSync(located.target).isDirectory()) {
        return { ok: false, status: 400, error: `任务工作目录不是目录: ${task.cwd || '.'}` }
      }
    } catch {
      return { ok: false, status: 400, error: `任务工作目录不存在: ${task.cwd || '.'}` }
    }

    const run = new TaskRun({
      id: `r${crypto.randomBytes(6).toString('hex')}`,
      taskId: task.id,
      taskName: task.name,
      rootId,
      rootName,
      file: task.file,
      args: task.args,
      cwd: located.target,
      env: task.env,
      background: task.background,
      commandLine: task.commandLine
    })

    // A fresh run supersedes the previous one's findings for this task.
    const previous = this.lastRunByTask.get(key)
    if (previous) this.center.clear({ groupId: previous })
    this.lastRunByTask.set(key, run.id)
    this.activeByTask.set(key, run.id)
    this.runs.set(run.id, run)
    this.pruneHistory()

    const scanner = new DiagnosticScanner()
    run.on('line', (line: TaskLogLine) => {
      this.emit('line', { runId: run.id, line })
      const found = scanner.push(line.text)
      if (found.length === 0) return
      const added = this.center.add({
        origin: 'task',
        source: task.name,
        groupId: run.id,
        diagnostics: found,
        ...(input.resolvePath ? { resolvePath: input.resolvePath } : {})
      })
      run.countProblems(added.length)
      this.emit('runs', this.list())
    })
    run.once('end', (info: TaskRunInfo) => {
      this.activeByTask.delete(key)
      if (info.state === 'failed') {
        // A failure with no parsed diagnostic still belongs in the center —
        // otherwise "exit 1 with unparseable output" would look like success.
        this.center.note({
          origin: 'task',
          source: info.taskName,
          groupId: run.id,
          severity: 'error',
          message: `任务「${info.taskName}」失败,退出码 ${info.exitCode ?? '未知'}(${info.commandLine})`,
          tool: 'task'
        })
      }
      this.emit('end', info)
      this.emit('runs', this.list())
    })

    run.start()
    this.emit('runs', this.list())
    return { ok: true, run }
  }

  async stop(runId: string): Promise<boolean> {
    const run = this.runs.get(runId)
    if (!run) return false
    await run.stop()
    this.emit('runs', this.list())
    return true
  }

  /** Stop every run started in a directory that just left the workspace. */
  async stopForRoot(rootId: string): Promise<number> {
    const targets = [...this.runs.values()].filter((run) => run.running && run.info().rootId === rootId)
    await Promise.allSettled(targets.map((run) => run.stop()))
    return targets.length
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.runs.values()].filter((run) => run.running).map((run) => run.stop()))
  }

  /** Forget finished runs (and their diagnostics). */
  clearHistory(): number {
    const finished = [...this.runs.values()].filter((run) => !run.running)
    for (const run of finished) {
      this.center.clear({ groupId: run.id })
      this.runs.delete(run.id)
    }
    if (finished.length > 0) this.emit('runs', this.list())
    return finished.length
  }

  private pruneHistory(): void {
    const finished = [...this.runs.values()]
      .filter((run) => !run.running)
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const run of finished.slice(0, Math.max(0, this.runs.size - MAX_RUN_HISTORY))) {
      this.center.clear({ groupId: run.id })
      this.runs.delete(run.id)
    }
  }
}

export const taskManager = new TaskManager()

/** Kill running tasks before the control process dies. */
export function registerTaskShutdown(manager: TaskManager = taskManager): void {
  onShutdown(() => manager.stopAll())
}
