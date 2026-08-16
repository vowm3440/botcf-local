import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RouteInfo, streamChat, api, StreamEvent, SessionSummary, ChangedFileInfo } from '../api'
import FileTree from '../components/FileTree'

interface ToolCall {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  args?: unknown
  intent?: string
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
            <pre style={{ margin: '4px 0', padding: 8, overflowX: 'auto', background: '#161b22', color: '#ddd', fontSize: 12 }}>
              {tool.diff.split('\n').map((line, index) => (
                <span key={index} style={{ display: 'block', color: line.startsWith('+') ? '#7ee787' : line.startsWith('-') ? '#ffa198' : undefined }}>{line || ' '}</span>
              ))}
            </pre>
          </>
        )}
      </div>
    </details>
  )
}

/** Expand and scroll to the tool card that produced a file change. */
function jumpToTool(toolCallId: string): void {
  const el = document.getElementById(`tool-${toolCallId}`)
  if (!el) return
  el.setAttribute('open', '')
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function ChangedFilesRow({ files }: { files: ChangedFileInfo[] }) {
  return (
    <div style={{ marginTop: 8, fontSize: 12 }}>
      <span style={{ color: '#666' }}>本轮变更 {files.length} 个文件:</span>
      {files.map((file) => (
        <button
          key={file.path}
          onClick={() => jumpToTool(file.lastToolCallId)}
          title={`${file.tools.join(', ')}${file.hasDiff ? ' · 点击查看差异' : ''}`}
          style={{ marginLeft: 6, marginTop: 4, fontFamily: 'monospace', fontSize: 12, padding: '1px 6px', borderRadius: 4, cursor: 'pointer', border: `1px solid ${file.isError ? '#efb4b4' : '#cfe3cf'}`, background: file.isError ? '#fff2f0' : '#f2fbf2', color: file.isError ? '#c00' : '#2a7d46' }}
        >
          {file.path}
        </button>
      ))}
    </div>
  )
}

export default function Chat({ route, ompRunning }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sessionTokens, setSessionTokens] = useState({ input: 0, output: 0 })
  const [contextUsage, setContextUsage] = useState<{ tokens: number; contextWindow: number; percent: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [currentSessionPath, setCurrentSessionPath] = useState('')
  const [showFiles, setShowFiles] = useState(true)
  const abortRef = useRef<AbortController | null>(null)
  const historyLoaded = useRef(false)

  /** Session-cumulative changed files, merged across every turn's summary. */
  const sessionChanged = useMemo(() => {
    const merged = new Map<string, ChangedFileInfo>()
    for (const message of messages) {
      for (const file of message.changedFiles ?? []) {
        const prev = merged.get(file.path)
        merged.set(file.path, prev ? { ...file, tools: [...new Set([...prev.tools, ...file.tools])] } : file)
      }
    }
    return merged
  }, [messages])

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
    if (ev.type === 'tool') updateTool(ev)
    if (ev.type === 'files_changed' && ev.files) {
      const files = ev.files
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
      setSessionTokens({ input: 0, output: 0 })
      setContextUsage(null)
      await loadHistory()
      setNotice('会话已切换')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '切换会话失败')
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', maxWidth: 960, width: '100%', margin: '0 auto', padding: 16, boxSizing: 'border-box', minHeight: 0 }}>
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
      </div>

      <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 8, padding: 16, background: '#fff', minHeight: 0 }}>
        {!route && <p style={{ color: '#888' }}>请先在顶部选择分组和模型。</p>}
        {messages.map((message, index) => (
          <div key={index} style={{ marginBottom: 14 }}>
            <strong>{message.role === 'user' ? '你' : '助手'}:</strong>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{message.content || (streaming && index === messages.length - 1 && !message.tools?.length ? '…' : '')}</div>
            {message.tools?.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
            {message.changedFiles && message.changedFiles.length > 0 && <ChangedFilesRow files={message.changedFiles} />}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }}
          disabled={!route || (streaming && !ompRunning)}
          placeholder={!route ? '未选择路由' : streaming ? (ompRunning ? '生成中——输入内容回车可追加引导…' : '生成中…') : '输入消息…'}
          style={{ flex: 1, padding: 12, borderRadius: 6, border: '1px solid #ccc' }}
        />
        {streaming
          ? <button onClick={abort} style={{ padding: '0 20px', background: '#d33', color: '#fff', border: 'none', borderRadius: 6 }}>中止</button>
          : <button onClick={send} disabled={!route || !input.trim()} style={{ padding: '0 20px', borderRadius: 6 }}>发送</button>}
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
        会话 Token — 输入 {sessionTokens.input.toLocaleString()} / 输出 {sessionTokens.output.toLocaleString()}
        {contextUsage && <> · 上下文 {contextUsage.tokens.toLocaleString()}/{contextUsage.contextWindow.toLocaleString()} ({contextUsage.percent.toFixed(1)}%)</>}
        {route && <> · {route.apiType} · {route.capabilityLabel}</>}
        {ompRunning ? ' · OMP 会话' : ' · 直连模式'}
      </div>
      </div>
      {ompRunning && showFiles && <FileTree changed={sessionChanged} onJumpToTool={jumpToTool} />}
    </div>
  )
}
