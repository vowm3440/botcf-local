import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, streamChat, type ChangedFileInfo, type RouteInfo, type SessionSummary, type StreamEvent } from '../api'
import { absorbChangedFile, isMutatingToolName, mergeChangedFiles } from './changedFiles'
import { appendAssistantDelta, appendAssistantReasoning, appendAssistantText, appendNotice, applyToolFrame, attachChangedFiles, type ChatMessage } from './messages'
import { isOutsideWorkspace } from '../workspace/paths'

/** Everything the assistant conversation *is*, separate from how it looks.
 *
 *  The workbench needs more than a chat pane out of this: the file tree marks the
 *  files this session changed, the editor shows their diffs and the status bar
 *  shows the token counters. Owning that state in a hook is what lets those parts
 *  sit in three different slots of the layout and still agree.
 *
 *  The subscription belongs to the instance, so the hook must stay mounted for
 *  the whole session — hiding the chat pane hides it with CSS, it never unmounts. */

export interface ContextUsage {
  tokens: number
  contextWindow: number
  percent: number
}

export interface ChatSessionOptions {
  route: RouteInfo | null
  ompRunning: boolean
  /** Hand a changed file to the editor. */
  openFile: (path: string, options?: { activate?: boolean }) => void
  /** Unsaved edits in the front tab mean a changed file opens in the background. */
  activeIsDirty: boolean
}

export interface ChatSessionApi {
  messages: ChatMessage[]
  input: string
  setInput: (value: string) => void
  streaming: boolean
  notice: string | null
  sessions: SessionSummary[]
  currentSessionPath: string
  sessionTokens: { input: number; output: number }
  contextUsage: ContextUsage | null
  /** Cumulative changed files for the session, keyed by qualified workspace path. */
  changedFiles: Map<string, ChangedFileInfo>
  send: () => Promise<void>
  abort: () => void
  newSession: () => Promise<void>
  switchSession: (path: string) => Promise<void>
}

export function useChatSession({ route, ompRunning, openFile, activeIsDirty }: ChatSessionOptions): ChatSessionApi {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sessionTokens, setSessionTokens] = useState({ input: 0, output: 0 })
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [currentSessionPath, setCurrentSessionPath] = useState('')
  /** Files changed by the in-flight turn, so the tree does not wait for the
   *  end-of-turn summary. */
  const [liveChanged, setLiveChanged] = useState<ChangedFileInfo[]>([])
  const abortRef = useRef<AbortController | null>(null)
  /** Tool call id → workdir-relative path, remembered from start frames so an end
   *  frame without args can still auto-open the file it changed. */
  const toolPathsRef = useRef(new Map<string, string>())
  const historyLoaded = useRef(false)
  /** Streaming re-renders on every token; the event handler reads the editor
   *  through refs so it never closes over a stale render. */
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile
  const activeIsDirtyRef = useRef(activeIsDirty)
  activeIsDirtyRef.current = activeIsDirty

  /** Session-cumulative changed files: every turn's summary plus the in-flight
   *  turn's live entries. */
  const changedFiles = useMemo(
    () => mergeChangedFiles([...messages.flatMap((message) => message.changedFiles ?? []), ...liveChanged]),
    [messages, liveChanged]
  )

  const loadHistory = useCallback(async () => {
    const response = await api.history()
    if (response.source === 'omp') {
      setMessages(response.messages)
      if (response.messages.length > 0) setNotice(`已恢复 ${response.messages.length} 条历史消息`)
    }
  }, [])

  const loadSessions = useCallback(async () => {
    const response = await api.sessions()
    setSessions(response.sessions)
    setCurrentSessionPath(response.currentSessionPath ?? '')
  }, [])

  useEffect(() => {
    if (!ompRunning || historyLoaded.current) return
    historyLoaded.current = true
    Promise.all([loadHistory(), loadSessions()]).catch(() => undefined)
  }, [loadHistory, loadSessions, ompRunning])

  const onToolEvent = (ev: StreamEvent): void => {
    if (!ev.id || !ev.name || !ev.phase) return
    const id = ev.id
    setMessages((prev) =>
      applyToolFrame(prev, {
        id,
        name: ev.name ?? '工具',
        phase: ev.phase ?? 'start',
        isError: ev.isError,
        args: ev.args,
        intent: ev.intent,
        path: ev.path,
        output: ev.output,
        diff: ev.diff
      })
    )
    if (ev.path) toolPathsRef.current.set(id, ev.path)
    if (ev.phase !== 'end') return

    const target = ev.path ?? toolPathsRef.current.get(id)
    const mutating = Boolean(ev.diff) || isMutatingToolName(ev.name ?? '')
    // A failed call with no diff changed nothing: neither list it nor jump to it.
    if (!target || !mutating || (!ev.diff && ev.isError)) return
    const entry: ChangedFileInfo = {
      path: target,
      tools: [ev.name ?? '工具'],
      lastToolCallId: id,
      hasDiff: Boolean(ev.diff),
      isError: ev.isError === true,
      ...(ev.diff ? { diff: ev.diff } : {})
    }
    setLiveChanged((prev) => absorbChangedFile(prev, entry))
    // Every file the assistant finishes gets its own tab. Files outside the
    // workspace cannot be read by the file API, so opening one would only show
    // an error.
    if (!ev.isError && !isOutsideWorkspace(target)) {
      openFileRef.current(target, { activate: !activeIsDirtyRef.current })
    }
  }

  const onFilesChanged = (files: readonly ChangedFileInfo[]): void => {
    // The server's end-of-turn summary supersedes this turn's live entries for
    // the same paths, so diffs are not concatenated twice.
    setLiveChanged((prev) => prev.filter((file) => !files.some((summary) => summary.path === file.path)))
    for (const file of files) {
      if (!isOutsideWorkspace(file.path)) openFileRef.current(file.path, { activate: false })
    }
    const lastChanged = files[files.length - 1]
    if (lastChanged && !activeIsDirtyRef.current && !isOutsideWorkspace(lastChanged.path)) {
      openFileRef.current(lastChanged.path)
    }
    setMessages((prev) => attachChangedFiles(prev, files))
  }

  const onEvent = (ev: StreamEvent): void => {
    if (ev.type === 'delta' && ev.text) {
      const text = ev.text
      setMessages((prev) => appendAssistantDelta(prev, text))
    }
    if (ev.type === 'reasoning' && ev.text) {
      const text = ev.text
      setMessages((prev) => appendAssistantReasoning(prev, text))
    }
    if (ev.type === 'notice' && ev.text) {
      const notice = { level: ev.level === 'warn' ? ('warn' as const) : ('info' as const), text: ev.text }
      setMessages((prev) => appendNotice(prev, notice))
    }
    if (ev.type === 'tool') onToolEvent(ev)
    if (ev.type === 'files_changed' && ev.files) onFilesChanged(ev.files)
    if (ev.type === 'usage') {
      setSessionTokens((prev) => ({
        input: prev.input + (ev.inputTokens ?? 0),
        output: prev.output + (ev.outputTokens ?? 0)
      }))
    }
    if (ev.type === 'context' && ev.contextWindow) {
      setContextUsage({ tokens: ev.tokens ?? 0, contextWindow: ev.contextWindow, percent: ev.percent ?? 0 })
    }
    if (ev.type === 'error') {
      const message = ev.message ?? '未知错误'
      setMessages((prev) => appendAssistantText(prev, (content) => content + `\n\n[错误] ${message}`))
    }
    if (ev.type === 'aborted') {
      setMessages((prev) => appendAssistantText(prev, (content) => content + '\n\n[已中止]'))
    }
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || !route) return

    // Mid-turn input steers the run instead of starting a new one.
    if (streaming) {
      if (!ompRunning) return
      setMessages((prev) => [...prev, { role: 'user', content: `(追加) ${text}` }])
      setInput('')
      try {
        await api.steer(text)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '追加失败')
      }
      return
    }

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages([...nextMessages, { role: 'assistant', content: '' }])
    setInput('')
    setStreaming(true)
    setNotice(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChat(nextMessages.map(({ role, content }) => ({ role, content })), onEvent, controller.signal)
    } catch (error) {
      const suffix = controller.signal.aborted
        ? '\n\n[已中止]'
        : `\n\n[错误] ${error instanceof Error ? error.message : String(error)}`
      setMessages((prev) => appendAssistantText(prev, (content) => content + suffix))
    } finally {
      setStreaming(false)
      abortRef.current = null
      loadSessions().catch(() => undefined)
      window.dispatchEvent(new CustomEvent('botcf:turn-complete'))
    }
  }

  const abort = (): void => {
    abortRef.current?.abort()
    api.abort().catch(() => undefined)
  }

  /** Everything a session accumulated, dropped in one place so a new or switched
   *  session never shows the previous one's counters. */
  const resetSessionState = (): void => {
    setLiveChanged([])
    toolPathsRef.current.clear()
    setSessionTokens({ input: 0, output: 0 })
    setContextUsage(null)
  }

  const newSession = async (): Promise<void> => {
    try {
      await api.newSession()
      setMessages([])
      resetSessionState()
      setNotice('已开始新会话')
      await loadSessions()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '新建会话失败')
    }
  }

  const switchSession = async (sessionPath: string): Promise<void> => {
    if (!sessionPath || sessionPath === currentSessionPath) return
    try {
      await api.switchSession(sessionPath)
      setCurrentSessionPath(sessionPath)
      resetSessionState()
      await loadHistory()
      setNotice('会话已切换')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '切换会话失败')
    }
  }

  return {
    messages,
    input,
    setInput,
    streaming,
    notice,
    sessions,
    currentSessionPath,
    sessionTokens,
    contextUsage,
    changedFiles,
    send,
    abort,
    newSession,
    switchSession
  }
}
