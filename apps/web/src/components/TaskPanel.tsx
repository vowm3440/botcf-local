import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import LogPane, { type LogEntry } from './LogPane'
import RootPicker from './RootPicker'
import { BUTTON, DANGER_BUTTON, EMPTY_HINT, MONO, PANEL_BODY, PRIMARY_BUTTON, ROW, SCROLL_AREA, STATUS_LINE, TOOLBAR, formatDuration } from './ui'
import {
  TASK_KIND_LABELS,
  tasksApi,
  type TaskEvent,
  type TaskInfo,
  type TaskListResponse,
  type TaskLogLine,
  type TaskRunInfo
} from '../services/tasks'
import { onWorkspaceChanged } from '../workspace/events'
import { onProjectConfigSaved } from '../panels/events'

/** Unified build / run / test panel.
 *
 *  One list, one mechanism: tasks come from `.botcf/config.json` and from the
 *  project's package.json scripts, and every one of them runs the same way — a
 *  child process whose output streams here and whose errors land in the
 *  diagnostics center. A task never starts by itself: it executes project code,
 *  so it waits for a click, and the exact command line is always visible. */

const STREAM_TONE: Record<TaskLogLine['stream'], LogEntry['tone']> = {
  stdout: 'out',
  stderr: 'err',
  system: 'sys'
}

const STATE_MARKS: Record<TaskRunInfo['state'], { mark: string; color: string; label: string }> = {
  running: { mark: '●', color: '#0969da', label: '运行中' },
  succeeded: { mark: '✓', color: '#1a7f37', label: '成功' },
  failed: { mark: '✗', color: '#cf222e', label: '失败' },
  stopped: { mark: '■', color: '#9a6700', label: '已停止' }
}

export default function TaskPanel() {
  const [rootId, setRootId] = useState('')
  const [list, setList] = useState<TaskListResponse | null>(null)
  const [runs, setRuns] = useState<TaskRunInfo[]>([])
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, TaskLogLine[]>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const lastSeq = useRef<Record<string, number>>({})
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedRun
  const rootRef = useRef('')

  const applyLines = useCallback((runId: string, incoming: readonly TaskLogLine[]) => {
    if (incoming.length === 0) return
    setLogs((prev) => {
      const known = lastSeq.current[runId] ?? 0
      const fresh = incoming.filter((line) => line.seq > known)
      if (fresh.length === 0) return prev
      lastSeq.current[runId] = fresh[fresh.length - 1].seq
      return { ...prev, [runId]: [...(prev[runId] ?? []), ...fresh].slice(-1_000) }
    })
  }, [])

  const load = useCallback(async (root?: string) => {
    try {
      const next = await tasksApi.list(root ?? rootRef.current)
      setList(next)
      rootRef.current = next.root.id
      setRootId(next.root.id)
      setRuns(next.runs)
      setNotice(next.configWarnings.length > 0 ? `项目配置有 ${next.configWarnings.length} 条提示` : null)
      return next
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '任务列表读取失败')
      return null
    }
  }, [])

  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  useEffect(() => onWorkspaceChanged(() => { load().catch(() => undefined) }), [load])

  // Editing the project config changes what is runnable.
  useEffect(() => onProjectConfigSaved(() => { load().catch(() => undefined) }), [load])

  useEffect(() => {
    const source = new EventSource(tasksApi.eventsUrl())
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as TaskEvent
        if (frame.type === 'task_runs') setRuns(frame.runs)
        if (frame.type === 'task_line') applyLines(frame.runId, [frame.line])
        if (frame.type === 'task_end') {
          setRuns((prev) => prev.map((run) => (run.id === frame.run.id ? frame.run : run)))
          // Refresh the task list so its "running" markers match reality.
          load().catch(() => undefined)
        }
      } catch {
        /* ignore malformed frames */
      }
    }
    source.onopen = () => {
      const current = selectedRef.current
      if (!current) return
      tasksApi
        .runLog(current, lastSeq.current[current] ?? 0)
        .then((result) => applyLines(current, result.lines))
        .catch(() => undefined)
    }
    return () => source.close()
  }, [applyLines, load])

  const run = async (task: TaskInfo): Promise<void> => {
    setBusy(true)
    try {
      const result = await tasksApi.run({ root: rootId, taskId: task.id })
      setSelectedRun(result.run.id)
      lastSeq.current[result.run.id] = 0
      applyLines(result.run.id, result.lines)
      setRuns((prev) => [result.run, ...prev.filter((entry) => entry.id !== result.run.id)])
      setNotice(null)
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '任务启动失败')
    } finally {
      setBusy(false)
    }
  }

  const stop = async (runId: string): Promise<void> => {
    try {
      const result = await tasksApi.stop(runId)
      setRuns(result.runs)
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '停止失败')
    }
  }

  const selectRun = async (runId: string): Promise<void> => {
    setSelectedRun(runId)
    if (logs[runId] !== undefined) return
    try {
      const result = await tasksApi.runLog(runId)
      lastSeq.current[runId] = 0
      applyLines(runId, result.lines)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '任务日志读取失败')
    }
  }

  const groups = useMemo(() => {
    const tasks = list?.tasks ?? []
    const byId = new Map(tasks.map((task) => [task.id, task]))
    return (list?.groups ?? [])
      .map((group) => ({
        kind: group.kind,
        tasks: group.taskIds.map((id) => byId.get(id)).filter((task): task is TaskInfo => task !== undefined)
      }))
      .filter((group) => group.tasks.length > 0)
  }, [list])

  const activeRun = useMemo(() => runs.find((entry) => entry.id === selectedRun) ?? null, [runs, selectedRun])
  const entries: LogEntry[] = useMemo(
    () =>
      (selectedRun ? logs[selectedRun] ?? [] : []).map((line) => ({
        key: line.seq,
        text: line.text,
        tone: STREAM_TONE[line.stream]
      })),
    [logs, selectedRun]
  )

  return (
    <div style={PANEL_BODY}>
      <div style={TOOLBAR}>
        <RootPicker
          roots={list?.roots ?? []}
          value={rootId}
          disabled={busy}
          label="任务目录"
          onChange={(id) => {
            setRootId(id)
            load(id).catch(() => undefined)
          }}
        />
        <button style={BUTTON} onClick={() => { load().catch(() => undefined) }}>
          刷新
        </button>
        <span style={{ flex: 1 }} />
        {runs.length > 0 && (
          <select
            aria-label="执行记录"
            value={selectedRun ?? ''}
            onChange={(event) => { selectRun(event.target.value).catch(() => undefined) }}
            style={{ fontSize: 12, maxWidth: 240 }}
          >
            <option value="">选择执行记录…</option>
            {runs.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {STATE_MARKS[entry.state].mark} {entry.rootName}/{entry.taskName} · {formatDuration(entry.durationMs)}
              </option>
            ))}
          </select>
        )}
        <button
          style={BUTTON}
          disabled={runs.every((entry) => entry.state === 'running')}
          title="清空已结束的执行记录及其诊断"
          onClick={() => {
            tasksApi
              .clearHistory()
              .then((result) => {
                setRuns(result.runs)
                setLogs({})
                setSelectedRun(null)
              })
              .catch((error: unknown) => setNotice(error instanceof Error ? error.message : '清空失败'))
          }}
        >
          清空记录
        </button>
      </div>

      <div style={{ ...STATUS_LINE, color: notice ? '#9a6700' : '#666' }}>
        {notice ??
          (list
            ? `${list.tasks.length} 个任务 · 包管理器 ${list.packageManager} · 任务来自项目配置与 package.json`
            : '读取任务…')}
      </div>

      {list?.configWarnings.length ? (
        <div style={{ padding: '4px 8px', fontSize: 11, color: '#9a6700', background: '#fffbe6', borderBottom: '1px solid #ffe58f' }}>
          {list.configWarnings.map((warning, index) => (
            <div key={index}>{warning}</div>
          ))}
        </div>
      ) : null}

      <div style={{ ...SCROLL_AREA, maxHeight: '50%' }}>
        {groups.length === 0 && (
          <div style={EMPTY_HINT}>
            这个目录里没有可运行的任务。给项目加上 package.json 脚本,
            或在「项目配置」面板里声明 tasks(可指定命令、子目录与环境变量)。
          </div>
        )}
        {groups.map((group) => (
          <div key={group.kind}>
            <div style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, color: '#57606a', background: '#f6f8fa', borderBottom: '1px solid #eee' }}>
              {TASK_KIND_LABELS[group.kind]}
            </div>
            {group.tasks.map((task) => {
              const state = task.run ? STATE_MARKS[task.run.state] : null
              return (
                <div key={task.id} style={ROW}>
                  <span style={{ flex: 'none', width: 14, color: state?.color ?? '#d0d7de' }}>{state?.mark ?? '·'}</span>
                  <span style={{ flex: 'none', fontWeight: 600 }}>{task.name}</span>
                  <span
                    style={{ flex: 1, minWidth: 0, fontFamily: MONO, color: '#8c959f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={`${task.commandLine}${task.cwd ? `  (cwd=${task.cwd})` : ''}`}
                  >
                    {task.commandLine}
                  </span>
                  <span style={{ flex: 'none', fontSize: 10, color: '#8c959f', border: '1px solid #eee', borderRadius: 3, padding: '0 4px' }}>
                    {task.source === 'config' ? '配置' : '脚本'}
                  </span>
                  {task.run?.state === 'running' ? (
                    <>
                      <button style={BUTTON} onClick={() => { selectRun(task.run!.id).catch(() => undefined) }}>
                        查看
                      </button>
                      <button style={DANGER_BUTTON} onClick={() => { stop(task.run!.id).catch(() => undefined) }}>
                        停止
                      </button>
                    </>
                  ) : (
                    <>
                      {task.run && (
                        <button
                          style={BUTTON}
                          title={`上次${STATE_MARKS[task.run.state].label} · ${formatDuration(task.run.durationMs)}`}
                          onClick={() => { selectRun(task.run!.id).catch(() => undefined) }}
                        >
                          上次输出
                        </button>
                      )}
                      <button style={PRIMARY_BUTTON} disabled={busy} onClick={() => { run(task).catch(() => undefined) }}>
                        运行
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid #ddd' }}>
        <div style={{ ...STATUS_LINE, background: '#f6f8fa' }}>
          {activeRun
            ? `${activeRun.rootName}/${activeRun.taskName} · ${STATE_MARKS[activeRun.state].label} · ${formatDuration(activeRun.durationMs)}${activeRun.exitCode !== null ? ` · exit ${activeRun.exitCode}` : ''}${activeRun.problemCount > 0 ? ` · ${activeRun.problemCount} 个问题` : ''}`
            : '选择一个任务执行记录查看输出'}
        </div>
        <LogPane entries={entries} emptyText="(运行任务后这里显示输出)" />
      </div>
    </div>
  )
}
