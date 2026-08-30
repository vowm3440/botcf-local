import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RouteInfo, streamChat, api, StreamEvent, SessionSummary, ChangedFileInfo } from '../api'
import ChatInput from '../components/ChatInput'
import DiffView from '../components/DiffView'
import EditorTabs from '../components/EditorTabs'
import FileTree from '../components/FileTree'
import PanelGrid, { GridPanelDef } from '../components/PanelGrid'
import PanelToggles from '../components/PanelToggles'
import PreviewPanel from '../components/PreviewPanel'
import { onOpenFileRequest } from '../editor/openFile'
import { useOpenTabs } from '../editor/useOpenTabs'
import { idePanelDefs } from '../panels/idePanels'
import { usePanelToggles } from '../panels/usePanelToggles'
import { useWorkbenchBadges } from '../panels/useWorkbenchBadges'
import { onWorkspaceChanged } from '../workspace/events'
import { isOutsideWorkspace, rootNameOf } from '../workspace/paths'

interface ToolCall {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  args?: unknown
  intent?: string
  path?: string
  output?: string
  diff?: string
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  tools?: ToolCall[]
  changedFiles?: ChangedFileInfo[]
}

interface ChatProps {
  route: RouteInfo | null
  ompRunning: boolean
  /** 页面是否可见。隐藏时组件保持挂载以继续接收流式数据,只是不做滚动。 */
  active?: boolean
}

function ToolCard({ tool }: { tool: ToolCall }) {
  const status = tool.status === 'running' ? '执行中' : tool.status === 'error' ? '失败' : '完成'
  return (
    <details id={`tool-${tool.id}`} open={tool.status === 'running'} style={{ marginTop: 8, border: `1px solid ${tool.status === 'error' ? '#efb4b4' : '#d9d9d9'}`, borderRadius: 6, background: '#fafafa' }}>
      <summary style={{ cursor: 'pointer', padding: '8px 10px', fontWeight: 600 }}>
        {tool.name} <span style={{ color: tool.status === 'error' ? '#c00' : '#777', fontWeight: 400 }}>· {status}</span>
        {tool.intent && <span style={{ color: '#777', fontWeight: 400 }}> · {tool.intent}</span>}
      </summary>
      <div style={{ padding: '0 10px 10px' }}>
        {tool.args !== undefined && (
          <>
            <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>参数</div>
            <pre style={{ margin: '4px 0', padding: 8, overflowX: 'auto', background: '#f0f0f0', fontSize: 12 }}>{JSON.stringify(tool.args, null, 2)}</pre>
          </>
        )}
        {tool.output && (
          <>
            <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>输出</div>
            <pre style={{ margin: '4px 0', padding: 8, maxHeight: 280, overflow: 'auto', background: '#f0f0f0', fontSize: 12, whiteSpace: 'pre-wrap' }}>{tool.output}</pre>
          </>
        )}
        {tool.diff && (
          <>
            <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>文件差异</div>
            <div style={{ margin: '4px 0' }}>
              <DiffView diff={tool.diff} />
            </div>
          </>
        )}
      </div>
    </details>
  )
}

function ChangedFilesRow({ files, onOpen }: { files: ChangedFileInfo[]; onOpen: (path: string) => void }) {
  return (
    <div style={{ marginTop: 8, fontSize: 12 }}>
      <span style={{ color: '#666' }}>本轮变更 {files.length} 个文件:</span>
      {files.map((file) => (
        <button
          key={file.path}
          onClick={() => onOpen(file.path)}
          title={`${file.tools.join(', ')}${file.hasDiff ? ' · 点击查看差异' : ' · 点击查看文件'}`}
          style={{ marginLeft: 6, marginTop: 4, fontFamily: 'monospace', fontSize: 12, padding: '1px 6px', borderRadius: 4, cursor: 'pointer', border: `1px solid ${file.isError ? '#efb4b4' : '#cfe3cf'}`, background: file.isError ? '#fff2f0' : '#f2fbf2', color: file.isError ? '#c00' : '#2a7d46' }}
        >
          {file.path}
        </button>
      ))}
    </div>
  )
}

/** Mirror of the server's mutating-tool heuristic (omp/fileChanges.ts), used
 *  only to decide whether a finished tool call should auto-open its file. */
const NON_MUTATING = /^(read|grep|glob|ls|list|find|search|fetch|web|browse|bash|shell|exec|run|todo|task|think|plan)/i
const MUTATING_STEM = /(edit|write|patch|create|replace|save|move|rename)/i

function isMutatingToolName(name: string): boolean {
  return !NON_MUTATING.test(name) && MUTATING_STEM.test(name)
}

export default function Chat({ route, ompRunning, active = true }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sessionTokens, setSessionTokens] = useState({ input: 0, output: 0 })
  const [contextUsage, setContextUsage] = useState<{ tokens: number; contextWindow: number; percent: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [currentSessionPath, setCurrentSessionPath] = useState('')
  const [showFiles, setShowFiles] = useState(true)
  const [showPreview, setShowPreview] = useState(false)
  /** Git / 终端 / 任务 / 审查 / 配置 / 诊断 面板的开合,持久化到 localStorage。
   *  这些面板不依赖 OMP(直连模式下 git、终端、任务同样可用),因此开关常驻。 */
  const panelToggles = usePanelToggles('botcf.panels.v1')
  const { badges, alerts } = useWorkbenchBadges()
  /** 多标签编辑器:打开顺序与活动标签持久化到 localStorage。
   *  v2 起标签路径带工作区根名前缀(多根工作区),与 v1 的裸相对路径不兼容。 */
  const tabs = useOpenTabs('botcf.tabs.v2')
  /** 流式过程中即时累积的变更文件,让文件列表不必等轮次结束的汇总帧。 */
  const [liveChanged, setLiveChanged] = useState<ChangedFileInfo[]>([])
  const abortRef = useRef<AbortController | null>(null)
  /** Tool call id → workdir-relative file path, remembered from start frames so
   *  an end frame without args can still auto-open the file it changed. */
  const toolPathsRef = useRef(new Map<string, string>())
  const historyLoaded = useRef(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** Follow streaming output unless the user scrolled up to read. */
  const stickToBottom = useRef(true)

  /** 前台标签有未保存修改时,新文件只在后台开标签,不抢走正在编辑的视图。 */
  const openFile = useCallback(
    (path: string, options?: { activate?: boolean }) => {
      tabs.open(path, options ?? { activate: !tabs.activeIsDirty })
    },
    [tabs]
  )
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile
  const activeIsDirtyRef = useRef(tabs.activeIsDirty)
  activeIsDirtyRef.current = tabs.activeIsDirty
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // 目录被移出工作区后,指向它的标签页已经读不到文件了。关掉这些标签,但保留
  // 有未保存修改的那些——静默丢弃草稿比留一个报错的标签更糟。
  useEffect(
    () =>
      onWorkspaceChanged(() => {
        api.workspace()
          .then(({ roots }) => {
            const names = new Set(roots.map((root) => root.name))
            const editor = tabsRef.current
            for (const path of editor.tabs.paths) {
              if (!names.has(rootNameOf(path)) && !editor.dirtyPaths.has(path)) editor.close(path)
            }
          })
          .catch(() => undefined)
      }),
    []
  )

  // Git、审查、诊断面板都用这个信号把文件交给编辑器;带行号时由对应的
  // FileViewer 自己滚动到那一行(editor/openFile.ts)。
  useEffect(
    () =>
      onOpenFileRequest((request) => {
        if (isOutsideWorkspace(request.path)) return
        openFileRef.current(request.path, { activate: request.activate !== false })
      }),
    []
  )

  const onListScroll = () => {
    const el = listRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  // 滚动更新:流式内容追加时自动滚到底部,加载出下面的新内容。
  // 隐藏期间(display:none)scrollHeight 为 0,滚动无效,因此重新可见
  // (active 变 true)时也要补一次,把隐藏期间累积的内容滚出来。
  useEffect(() => {
    if (!active) return
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, active])

  /** Session-cumulative changed files, merged across every turn's summary plus
   *  the in-flight turn's live entries. */
  const sessionChanged = useMemo(() => {
    const DIFF_CAP = 200_000
    const merged = new Map<string, ChangedFileInfo>()
    const absorb = (file: ChangedFileInfo) => {
      const prev = merged.get(file.path)
      if (!prev) {
        merged.set(file.path, file)
        return
      }
      const joined = [prev.diff, file.diff].filter((part): part is string => Boolean(part)).join('\n')
      merged.set(file.path, {
        ...file,
        tools: [...new Set([...prev.tools, ...file.tools])],
        hasDiff: prev.hasDiff || file.hasDiff,
        diff: joined ? joined.slice(Math.max(0, joined.length - DIFF_CAP)) : undefined
      })
    }
    for (const message of messages) {
      for (const file of message.changedFiles ?? []) absorb(file)
    }
    // files_changed 到达时同名 live 条目已被清除,所以这里不会重复拼接差异。
    for (const file of liveChanged) absorb(file)
    return merged
  }, [messages, liveChanged])

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

  const appendToAssistant = (updater: (prev: string) => string) => {
    setMessages((prev) => {
      const copy = [...prev]
      const last = copy[copy.length - 1]
      if (!last || last.role !== 'assistant') {
        copy.push({ role: 'assistant', content: updater('') })
        return copy
      }
      copy[copy.length - 1] = { ...last, content: updater(last.content) }
      return copy
    })
  }

  const updateTool = (ev: StreamEvent) => {
    if (!ev.id || !ev.name || !ev.phase) return
    const id = ev.id
    const name = ev.name
    const phase = ev.phase
    setMessages((prev) => {
      const copy = [...prev]
      let assistantIndex = copy.length - 1
      if (assistantIndex < 0 || copy[assistantIndex].role !== 'assistant') {
        copy.push({ role: 'assistant', content: '', tools: [] })
        assistantIndex = copy.length - 1
      }
      const assistant = copy[assistantIndex]
      const tools = [...(assistant.tools ?? [])]
      const existingIndex = tools.findIndex((tool) => tool.id === id)
      const existing: ToolCall = existingIndex >= 0 ? tools[existingIndex] : { id, name, status: 'running' }
      const next: ToolCall = {
        ...existing,
        name,
        status: phase === 'end' ? (ev.isError ? 'error' : 'done') : 'running',
        args: ev.args ?? existing.args,
        intent: ev.intent ?? existing.intent,
        path: ev.path ?? existing.path,
        output: ev.output ?? existing.output,
        diff: ev.diff ?? existing.diff
      }
      if (existingIndex >= 0) tools[existingIndex] = next
      else tools.push(next)
      copy[assistantIndex] = { ...assistant, tools }
      return copy
    })
  }

  const onEvent = (ev: StreamEvent) => {
    if (ev.type === 'delta' && ev.text) {
      const text = ev.text
      appendToAssistant((content) => content + text)
    }
    if (ev.type === 'tool') {
      updateTool(ev)
      if (ev.id && ev.path) toolPathsRef.current.set(ev.id, ev.path)
      if (ev.phase === 'end' && ev.id) {
        const target = ev.path ?? toolPathsRef.current.get(ev.id)
        const mutating = Boolean(ev.diff) || isMutatingToolName(ev.name ?? '')
        // 失败且没有 diff 的调用没改动文件,不计入列表也不跳转。
        if (target && mutating && (ev.diff || !ev.isError)) {
          const entry: ChangedFileInfo = {
            path: target,
            tools: [ev.name ?? '工具'],
            lastToolCallId: ev.id,
            hasDiff: Boolean(ev.diff),
            isError: ev.isError === true,
            ...(ev.diff ? { diff: ev.diff } : {})
          }
          setLiveChanged((prev) => {
            const previous = prev.find((file) => file.path === target)
            const merged: ChangedFileInfo = previous
              ? {
                  ...entry,
                  tools: [...new Set([...previous.tools, ...entry.tools])],
                  hasDiff: previous.hasDiff || entry.hasDiff,
                  diff: [previous.diff, entry.diff].filter(Boolean).join('\n') || undefined
                }
              : entry
            return [...prev.filter((file) => file.path !== target), merged]
          })
          // AI 改完一个文件就为它开一个标签页(不再挤掉上一个文件)。工作区外的
          // 文件(路径为绝对形式)无法被文件接口读取,不打开以免只显示报错。
          if (!ev.isError && !isOutsideWorkspace(target)) {
            openFileRef.current(target, { activate: !activeIsDirtyRef.current })
          }
        }
      }
    }
    if (ev.type === 'files_changed' && ev.files) {
      const files = ev.files
      // 这一帧是服务端的权威汇总,取代同名文件的流式临时条目,避免差异重复拼接。
      setLiveChanged((prev) => prev.filter((file) => !files.some((summary) => summary.path === file.path)))
      // 兜底:轮次结束的权威汇总里,为每个变更文件补一个标签页。
      for (const file of files) {
        if (!isOutsideWorkspace(file.path)) {
          openFileRef.current(file.path, { activate: false })
        }
      }
      const lastChanged = files[files.length - 1]
      if (lastChanged && !activeIsDirtyRef.current && !isOutsideWorkspace(lastChanged.path)) {
        openFileRef.current(lastChanged.path)
      }
      setMessages((prev) => {
        const copy = [...prev]
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === 'assistant') {
            copy[i] = { ...copy[i], changedFiles: files }
            return copy
          }
        }
        return prev
      })
    }
    if (ev.type === 'usage') {
      setSessionTokens((prev) => ({ input: prev.input + (ev.inputTokens ?? 0), output: prev.output + (ev.outputTokens ?? 0) }))
    }
    if (ev.type === 'context' && ev.contextWindow) {
      setContextUsage({ tokens: ev.tokens ?? 0, contextWindow: ev.contextWindow, percent: ev.percent ?? 0 })
    }
    if (ev.type === 'error') appendToAssistant((content) => content + `\n\n[错误] ${ev.message ?? '未知错误'}`)
    if (ev.type === 'aborted') appendToAssistant((content) => content + '\n\n[已中止]')
  }

  const send = async () => {
    const text = input.trim()
    if (!text || !route) return
    stickToBottom.current = true

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

    const nextMessages: Message[] = [...messages, { role: 'user', content: text }]
    setMessages([...nextMessages, { role: 'assistant', content: '' }])
    setInput('')
    setStreaming(true)
    setNotice(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChat(nextMessages.map(({ role, content }) => ({ role, content })), onEvent, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) {
        appendToAssistant((content) => content + '\n\n[已中止]')
      } else {
        appendToAssistant((content) => content + `\n\n[错误] ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      loadSessions().catch(() => undefined)
      window.dispatchEvent(new CustomEvent('botcf:turn-complete'))
    }
  }

  const abort = () => {
    abortRef.current?.abort()
    api.abort().catch(() => undefined)
  }

  const newSession = async () => {
    try {
      await api.newSession()
      setMessages([])
      setLiveChanged([])
      toolPathsRef.current.clear()
      setSessionTokens({ input: 0, output: 0 })
      setContextUsage(null)
      setNotice('已开始新会话')
      await loadSessions()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '新建会话失败')
    }
  }

  const switchSession = async (sessionPath: string) => {
    if (!sessionPath || sessionPath === currentSessionPath) return
    try {
      await api.switchSession(sessionPath)
      setCurrentSessionPath(sessionPath)
      setLiveChanged([])
      toolPathsRef.current.clear()
      setSessionTokens({ input: 0, output: 0 })
      setContextUsage(null)
      await loadHistory()
      setNotice('会话已切换')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '切换会话失败')
    }
  }

  const chatPanelContent = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 12, boxSizing: 'border-box', minHeight: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: '#888', flex: 1 }}>{notice ?? ''}</span>
        {ompRunning && (
          <select aria-label="会话" value={currentSessionPath} onChange={(event) => switchSession(event.target.value)} disabled={streaming} style={{ maxWidth: 360, fontSize: 12 }}>
            {currentSessionPath && !sessions.some((session) => session.path === currentSessionPath) && (
              <option value={currentSessionPath}>当前新会话</option>
            )}
            {!currentSessionPath && <option value="">当前会话</option>}
            {sessions.map((session) => (
              <option key={session.path} value={session.path}>
                {session.title || session.preview || new Date(session.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        )}
        <button onClick={newSession} disabled={streaming} style={{ fontSize: 12 }}>新会话</button>
        {ompRunning && (
          <button onClick={() => setShowFiles((prev) => !prev)} style={{ fontSize: 12 }}>
            {showFiles ? '隐藏文件' : '文件'}
          </button>
        )}
        {ompRunning && (
          <button onClick={() => setShowPreview((prev) => !prev)} style={{ fontSize: 12 }}>
            {showPreview ? '隐藏预览' : '实时预览'}
          </button>
        )}
        <PanelToggles toggles={panelToggles} badges={badges} alerts={alerts} />
      </div>

      <div ref={listRef} onScroll={onListScroll} style={{ flex: 1, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 8, padding: 16, background: '#fff', minHeight: 0 }}>
        {!route && <p style={{ color: '#888' }}>请先在顶部选择分组和模型。</p>}
        {messages.map((message, index) => (
          <div key={index} style={{ marginBottom: 14 }}>
            <strong>{message.role === 'user' ? '你' : '助手'}:</strong>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 4 }}>{message.content || (streaming && index === messages.length - 1 && !message.tools?.length ? '…' : '')}</div>
            {message.tools?.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
            {message.changedFiles && message.changedFiles.length > 0 && <ChangedFilesRow files={message.changedFiles} onOpen={openFile} />}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end', minWidth: 0 }}>
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={send}
          disabled={!route || (streaming && !ompRunning)}
          placeholder={!route ? '未选择路由' : streaming ? (ompRunning ? '生成中——输入内容回车可追加引导,Shift+Enter 换行…' : '生成中…') : '输入消息…Enter 发送,Shift+Enter 换行'}
        />
        {streaming
          ? <button onClick={abort} style={{ flex: 'none', height: 42, padding: '0 20px', background: '#d33', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>中止</button>
          : <button onClick={send} disabled={!route || !input.trim()} style={{ flex: 'none', height: 42, padding: '0 20px', borderRadius: 6 }}>发送</button>}
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
        会话 Token — 输入 {sessionTokens.input.toLocaleString()} / 输出 {sessionTokens.output.toLocaleString()}
        {contextUsage && <> · 上下文 {contextUsage.tokens.toLocaleString()}/{contextUsage.contextWindow.toLocaleString()} ({contextUsage.percent.toFixed(1)}%)</>}
        {route && <> · {route.apiType} · {route.capabilityLabel}</>}
        {ompRunning ? ' · OMP 会话' : ' · 直连模式'}
      </div>
    </div>
  )

  const openTabCount = tabs.tabs.paths.length
  const gridPanels: GridPanelDef[] = [
    { id: 'chat', title: ompRunning ? 'OMP 对话' : '对话(直连模式)', minWidth: 320, minHeight: 200, weight: 3, content: chatPanelContent },
    ...(ompRunning && showFiles
      ? [{
          id: 'files',
          title: '工作区文件',
          minWidth: 180,
          weight: 1,
          closable: true,
          onClose: () => setShowFiles(false),
          content: <FileTree changed={sessionChanged} onOpenFile={openFile} />
        }]
      : []),
    ...(openTabCount > 0
      ? [{
          id: 'editor',
          title: `编辑器 · ${openTabCount} 个标签`,
          minWidth: 300,
          minHeight: 160,
          weight: 2,
          closable: true,
          onClose: tabs.closeAll,
          content: <EditorTabs tabs={tabs} diffFor={(path: string) => sessionChanged.get(path)?.diff} />
        }]
      : []),
    ...(showPreview
      ? [{
          id: 'preview',
          title: '实时预览',
          minWidth: 280,
          minHeight: 180,
          weight: 2,
          closable: true,
          onClose: () => setShowPreview(false),
          content: <PreviewPanel onClose={() => setShowPreview(false)} />
        }]
      : []),
    // Git / 终端 / 任务 / 审查 / 配置 / 诊断:只有打开的面板才挂载,关掉即停止其数据流。
    ...idePanelDefs(panelToggles)
  ]

  return <PanelGrid storageKey="botcf.grid.v2" panels={gridPanels} />
}
