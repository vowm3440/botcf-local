import { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { transcriptFile } from '../logs/transcripts.js'
import { detectProject } from '../preview/projectDetect.js'
import { loadProjectConfig } from '../projectConfig/store.js'
import { findTask, groupTasksByKind, resolveTasks, type TaskDefinition } from '../tasks/model.js'
import { taskManager } from '../tasks/manager.js'
import type { TaskLogLine, TaskRunInfo } from '../tasks/runner.js'
import { workspaceRootInfos } from '../workspace/locate.js'
import { requireWorkspaceRoot } from '../workspace/resolveRoot.js'
import { displayPathInWorkspace, getWorkspace } from '../workspace/store.js'

/** Unified build/run/test surface.
 *
 *  The task list for a root is derived on every request from the project config
 *  plus its package.json scripts, so editing either is reflected immediately and
 *  nothing stale is ever runnable. The client starts a task by *id* — it can never
 *  send a command line — and each run streams its output and its parsed problems
 *  (see diagnostics/) to whoever is attached. */

interface RootedTasks {
  root: { id: string; name: string; path: string }
  tasks: TaskDefinition[]
  warnings: string[]
  packageManager: string
}

function tasksForRoot(root: { id: string; name: string; path: string }): RootedTasks {
  const { config, warnings } = loadProjectConfig(root.path)
  const detected = detectProject(root.path)
  return {
    root,
    tasks: resolveTasks({ config, scripts: detected.scripts, packageManager: detected.packageManager }),
    warnings,
    packageManager: detected.packageManager
  }
}

/** Task plus its most recent run, which is what the panel renders: the live run
 *  while it runs, and afterwards the verdict it ended with. */
function withRunState(rootId: string, tasks: readonly TaskDefinition[]) {
  return tasks.map((task) => {
    const run = taskManager.latestRun(rootId, task.id)
    return { ...task, run: run ? run.info() : null }
  })
}

export function registerTaskRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { root?: string } }>('/api/tasks', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.query.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const { root, tasks, warnings, packageManager } = tasksForRoot(resolved.root)
    return {
      success: true,
      root: { id: root.id, name: root.name },
      roots: workspaceRootInfos(getWorkspace()),
      packageManager,
      configWarnings: warnings,
      tasks: withRunState(root.id, tasks),
      groups: groupTasksByKind(tasks).map((group) => ({ kind: group.kind, taskIds: group.tasks.map((task) => task.id) })),
      runs: taskManager.list()
    }
  })

  /** Run a task. Explicit user action — a task executes project code. */
  app.post<{ Body: { root?: string; taskId?: string } }>('/api/tasks/run', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const taskId = req.body?.taskId
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      return reply.code(400).send({ success: false, error: '缺少 taskId' })
    }
    const { root, tasks } = tasksForRoot(resolved.root)
    const task = findTask(tasks, taskId.trim())
    if (!task) return reply.code(404).send({ success: false, error: `没有这个任务: ${taskId.slice(0, 60)}` })
    const started = taskManager.start({
      task,
      rootId: root.id,
      rootName: root.name,
      rootPath: root.path,
      // Tools print paths relative to the directory they ran in; map them onto
      // the workspace so the diagnostics panel can open the right file.
      resolvePath: (file: string) =>
        displayPathInWorkspace(path.isAbsolute(file) ? file : path.resolve(root.path, task.cwd || '.', file))
    })
    if (!started.ok) return reply.code(started.status).send({ success: false, error: started.error })
    return { success: true, run: started.run.info(), lines: started.run.snapshot() }
  })

  app.post<{ Body: { runId?: string } }>('/api/tasks/stop', async (req, reply) => {
    const runId = req.body?.runId
    if (typeof runId !== 'string' || runId.trim() === '') {
      return reply.code(400).send({ success: false, error: '缺少 runId' })
    }
    const stopped = await taskManager.stop(runId.trim())
    if (!stopped) return reply.code(404).send({ success: false, error: '没有这个任务执行记录' })
    return { success: true, runs: taskManager.list() }
  })

  /** Full plain-text transcript of a run. The in-memory ring buffer keeps at
   *  most MAX_RUN_LINES lines; the disk copy behind this endpoint has them all,
   *  so an overlong build log stays paste-able after the panel turned over. */
  app.get<{ Params: { id: string } }>('/api/tasks/runs/:id/log', async (req, reply) => {
    const run = taskManager.get(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: '没有这个任务执行记录' })
    const file = transcriptFile(config.dataDir, 'tasks', run.info().rootId, req.params.id)
    try {
      const text = fs.readFileSync(file, 'utf8')
      return reply.type('text/plain; charset=utf-8').send(text)
    } catch {
      return reply.code(404).send({ success: false, error: '完整日志不存在(该执行没有输出或日志未启用)' })
    }
  })

  /** Log catch-up for one run; `after` is the last sequence number rendered. */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/tasks/runs/:id', async (req, reply) => {
    const run = taskManager.get(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: '没有这个任务执行记录' })
    const after = Number(req.query.after ?? 0)
    return {
      success: true,
      run: run.info(),
      lines: Number.isFinite(after) && after > 0 ? run.linesAfter(after) : run.snapshot()
    }
  })

  app.post('/api/tasks/clear', async () => ({ success: true, cleared: taskManager.clearHistory(), runs: taskManager.list() }))

  /** Live task output and state. */
  app.get<{ Querystring: { runId?: string; after?: string } }>('/api/tasks/events', (req, reply) => {
    const wanted = req.query.runId
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const send = (payload: Record<string, unknown>): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    send({ type: 'task_runs', runs: taskManager.list() })
    const after = Number(req.query.after ?? 0)
    if (wanted && Number.isFinite(after) && after > 0) {
      for (const line of taskManager.get(wanted)?.linesAfter(after) ?? []) {
        send({ type: 'task_line', runId: wanted, line })
      }
    }
    const onLine = ({ runId, line }: { runId: string; line: TaskLogLine }): void => {
      if (wanted && runId !== wanted) return
      send({ type: 'task_line', runId, line })
    }
    const onEnd = (info: TaskRunInfo): void => send({ type: 'task_end', run: info })
    const onRuns = (runs: TaskRunInfo[]): void => send({ type: 'task_runs', runs })
    const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    taskManager.on('line', onLine)
    taskManager.on('end', onEnd)
    taskManager.on('runs', onRuns)
    const cleanup = (): void => {
      clearInterval(keepalive)
      taskManager.off('line', onLine)
      taskManager.off('end', onEnd)
      taskManager.off('runs', onRuns)
    }
    req.raw.once('close', cleanup)
    reply.raw.once('close', cleanup)
  })
}
