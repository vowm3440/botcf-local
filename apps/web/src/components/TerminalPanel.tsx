import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import LogPane, { type LogEntry } from './LogPane'
import RootPicker from './RootPicker'
import { BUTTON, DANGER_BUTTON, EMPTY_HINT, INPUT, MONO, PANEL_BODY, PRIMARY_BUTTON, SELECT, STATUS_LINE, TOOLBAR } from './ui'
import {
  terminalApi,
  type ShellKind,
  type TerminalEvent,
  type TerminalLine,
  type TerminalSessionInfo
} from '../services/terminal'
import type { WorkspaceRootInfo } from '../api'
import { onWorkspaceChanged } from '../workspace/events'

/** Built-in terminal.
 *
 *  A session is a shell running in a workspace root; the transcript streams over
 *  SSE and is replayed from the server's ring buffer, so switching panels or
 *  reloading the page does not lose output. Sequence numbers make the catch-up
 *  exact: every line is applied once, in order, even if the stream opens after the
 *  snapshot was taken.
 *
 *  Honest limits, surfaced in the UI rather than hidden: there is no PTY, so
 *  full-screen programs and password prompts do not work, and 「中断」signals the
 *  process group — which usually ends the session, hence the 「新建会话」button. */

const KIND_TONE: Record<TerminalLine['kind'], LogEntry['tone']> = {
  stdout: 'out',
  stderr: 'err',
  input: 'in',
  system: 'sys'
}

const MAX_HISTORY = 50

export default function TerminalPanel() {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [roots, setRoots] = useState<WorkspaceRootInfo[]>([])
  const [shellKinds, setShellKinds] = useState<ShellKind[]>([])
  const [rootId, setRootId] = useState('')
  const [shell, setShell] = useState<ShellKind | ''>('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [lines, setLines] = useState<Record<string, TerminalLine[]>>({})
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** Highest sequence number applied per session, so catch-up never duplicates. */
  const lastSeq = useRef<Record<string, number>>({})
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

  const applyLines = useCallback((sessionId: string, incoming: readonly TerminalLine[]) => {
    if (incoming.length === 0) return
    setLines((prev) => {
      const known = lastSeq.current[sessionId] ?? 0
      const fresh = incoming.filter((line) => line.seq > known)
      if (fresh.length === 0) return prev
      lastSeq.current[sessionId] = fresh[fresh.length - 1].seq
      const merged = [...(prev[sessionId] ?? []), ...fresh]
      return { ...prev, [sessionId]: merged.slice(-1_500) }
    })
  }, [])

  const loadSessions = useCallback(async () => {
    try {
      const result = await terminalApi.list()
      setSessions(result.sessions)
      setRoots(result.roots)
      setShellKinds(result.shellKinds)
      setShell((prev) => prev || result.platformShell)
      const live = result.sessions.find((session) => session.running) ?? result.sessions[0] ?? null
      if (live && !activeRef.current) {
        setActiveId(live.id)
        const transcript = await terminalApi.transcript(live.id)
        applyLines(live.id, transcript.lines)
      }
      setNotice(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '终端状态读取失败')
    }
  }, [applyLines])

  useEffect(() => {
    loadSessions().catch(() => undefined)
  }, [loadSessions])

  useEffect(() => onWorkspaceChanged(() => { loadSessions().catch(() => undefined) }), [loadSessions])

  // One stream for every session: the panel can show any of them without
  // re-subscribing, and a background session keeps filling its buffer.
  useEffect(() => {
    const source = new EventSource(terminalApi.eventsUrl())
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as TerminalEvent
        if (frame.type === 'terminal_line') applyLines(frame.sessionId, [frame.line])
        if (frame.type === 'terminal_sessions') setSessions(frame.sessions)
        if (frame.type === 'terminal_exit') setSessions(frame.sessions)
      } catch {
        /* ignore malformed frames */
      }
    }
    source.onopen = () => {
      // Close the gap between the snapshot and the stream, if any.
      const current = activeRef.current
      if (!current) return
      terminalApi
        .transcript(current, lastSeq.current[current] ?? 0)
        .then((result) => applyLines(current, result.lines))
        .catch(() => undefined)
    }
    return () => source.close()
  }, [applyLines])

  const active = useMemo(() => sessions.find((session) => session.id === activeId) ?? null, [sessions, activeId])

  const open = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await terminalApi.open({
        ...(rootId ? { root: rootId } : {}),
        ...(shell ? { shell } : {})
      })
      setSessions((prev) => [...prev.filter((session) => session.id !== result.session.id), result.session])
      setActiveId(result.session.id)
      lastSeq.current[result.session.id] = 0
      applyLines(result.session.id, result.lines)
      setNotice(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '终端启动失败')
    } finally {
      setBusy(false)
    }
  }

  const select = async (id: string): Promise<void> => {
    setActiveId(id)
    if (lines[id] !== undefined) return
    try {
      const transcript = await terminalApi.transcript(id)
      applyLines(id, transcript.lines)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '终端记录读取失败')
    }
  }

  const send = async (): Promise<void> => {
    const text = input
    if (!activeId || text.trim() === '') return
    setInput('')
    setHistoryIndex(null)
    setHistory((prev) => [...prev.filter((entry) => entry !== text), text].slice(-MAX_HISTORY))
    try {
      await terminalApi.send(activeId, text)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '命令发送失败')
    }
  }

  const stepHistory = (offset: number): void => {
    if (history.length === 0) return
    const next = historyIndex === null ? history.length - 1 : historyIndex + offset
    if (next < 0 || next >= history.length) {
      setHistoryIndex(null)
      setInput('')
      return
    }
    setHistoryIndex(next)
    setInput(history[next])
  }

  const entries: LogEntry[] = useMemo(
    () =>
      (activeId ? lines[activeId] ?? [] : []).map((line) => ({
        key: line.seq,
        text: line.kind === 'input' ? `> ${line.text}` : line.text,
        tone: KIND_TONE[line.kind]
      })),
    [activeId, lines]
  )

  const statusText = active
    ? `${active.shell} · ${active.cwd} · ${active.running ? '运行中' : `已结束 (code=${active.exitCode ?? '未知'})`}`
    : '还没有终端会话'

  return (
    <div style={PANEL_BODY}>
      <div style={TOOLBAR}>
        <RootPicker roots={roots} value={rootId} disabled={busy} label="终端目录" onChange={setRootId} alwaysShow={roots.length > 1} />
        <select
          aria-label="shell"
          value={shell}
          disabled={busy}
          onChange={(event) => setShell(event.target.value as ShellKind)}
          style={{ ...SELECT, maxWidth: 120 }}
        >
          {shellKinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <button style={PRIMARY_BUTTON} disabled={busy} onClick={() => { open().catch(() => undefined) }}>
          新建会话
        </button>
        {sessions.length > 1 && (
          <select
            aria-label="终端会话"
            value={activeId ?? ''}
            onChange={(event) => { select(event.target.value).catch(() => undefined) }}
            style={{ ...SELECT, maxWidth: 220 }}
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.rootName} · {session.shell}
                {session.running ? '' : '(已结束)'}
              </option>
            ))}
          </select>
        )}
        <button
          style={BUTTON}
          disabled={!active?.running}
          title="发送中断信号(无 PTY,通常会结束会话)"
          onClick={() => {
            if (!activeId) return
            terminalApi.interrupt(activeId).catch((error: unknown) => setNotice(error instanceof Error ? error.message : '中断失败'))
          }}
        >
          中断
        </button>
        <button
          style={BUTTON}
          disabled={!activeId}
          title="只清空本面板显示,不影响会话"
          onClick={() => {
            if (!activeId) return
            setLines((prev) => ({ ...prev, [activeId]: [] }))
          }}
        >
          清屏
        </button>
        <button
          style={DANGER_BUTTON}
          disabled={!activeId || busy}
          onClick={() => {
            if (!activeId) return
            const target = activeId
            terminalApi
              .close(target)
              .then((result) => {
                setSessions(result.sessions)
                setActiveId(result.sessions.find((session) => session.running)?.id ?? null)
                setLines((prev) => {
                  const { [target]: _dropped, ...rest } = prev
                  return rest
                })
              })
              .catch((error: unknown) => setNotice(error instanceof Error ? error.message : '关闭失败'))
          }}
        >
          关闭会话
        </button>
      </div>

      <div style={{ ...STATUS_LINE, color: notice ? '#c00' : '#666' }} title={statusText}>
        {notice ?? statusText}
      </div>

      {!activeId ? (
        <div style={EMPTY_HINT}>
          点击「新建会话」在所选工作区目录里启动一个 shell。
          <div style={{ marginTop: 6, color: '#9a6700' }}>
            这是逐行执行的管道终端:适合 npm / git / 脚本这类命令行工具,
            不支持 vim、top 之类的全屏程序,也无法输入交互式密码。
          </div>
        </div>
      ) : (
        <LogPane
          entries={entries}
          emptyText="(等待输出…)"
          footer={
            <div style={{ display: 'flex', gap: 6, padding: 6, borderTop: '1px solid #1e2430', background: '#141821' }}>
              <span style={{ color: '#8ad0ff', fontFamily: MONO, fontSize: 12 }}>›</span>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    send().catch(() => undefined)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    stepHistory(-1)
                    return
                  }
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    stepHistory(1)
                    return
                  }
                  if (event.key === 'c' && event.ctrlKey && input === '' && activeId) {
                    event.preventDefault()
                    terminalApi.interrupt(activeId).catch(() => undefined)
                  }
                }}
                placeholder={active?.running ? '输入命令…Enter 执行,↑↓ 翻历史,Ctrl+C 中断' : '会话已结束,请新建会话'}
                aria-label="终端输入"
                spellCheck={false}
                disabled={!active?.running}
                style={{
                  ...INPUT,
                  flex: 1,
                  fontFamily: MONO,
                  background: '#0f1115',
                  color: '#d7dae0',
                  border: '1px solid #263041'
                }}
              />
            </div>
          }
        />
      )}
    </div>
  )
}
