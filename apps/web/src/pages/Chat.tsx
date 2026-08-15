import { useEffect, useRef, useState } from 'react'
import { RouteInfo, streamChat, api, StreamEvent } from '../api'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface ChatProps {
  route: RouteInfo | null
  ompRunning: boolean
}

export default function Chat({ route, ompRunning }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sessionTokens, setSessionTokens] = useState({ input: 0, output: 0 })
  const [contextUsage, setContextUsage] = useState<{ tokens: number; contextWindow: number; percent: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const historyLoaded = useRef(false)

  // OMP owns durable history — restore it once after load/restart.
  useEffect(() => {
    if (!ompRunning || historyLoaded.current) return
    historyLoaded.current = true
    api.history()
      .then((r) => {
        if (r.source === 'omp' && r.messages.length > 0) {
          setMessages(r.messages)
          setNotice(`已恢复 ${r.messages.length} 条历史消息`)
        }
      })
      .catch(() => undefined)
  }, [ompRunning])

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

  const onEvent = (ev: StreamEvent) => {
    if (ev.type === 'delta' && ev.text) {
      const text = ev.text
      appendToAssistant((c) => c + text)
    }
    if (ev.type === 'usage') {
      setSessionTokens((prev) => ({ input: prev.input + (ev.inputTokens ?? 0), output: prev.output + (ev.outputTokens ?? 0) }))
    }
    if (ev.type === 'context' && ev.contextWindow) {
      setContextUsage({ tokens: ev.tokens ?? 0, contextWindow: ev.contextWindow, percent: ev.percent ?? 0 })
    }
    if (ev.type === 'error') appendToAssistant((c) => c + `\n\n[错误] ${ev.message ?? '未知错误'}`)
    if (ev.type === 'aborted') appendToAssistant((c) => c + '\n\n[已中止]')
  }

  const send = async () => {
    const text = input.trim()
    if (!text || !route) return

    // While streaming in OMP mode, Enter queues a steering message instead.
    if (streaming) {
      if (!ompRunning) return
      setMessages((prev) => [...prev, { role: 'user', content: `(追加) ${text}` }])
      setInput('')
      try {
        await api.steer(text)
      } catch (e) {
        setNotice(e instanceof Error ? e.message : '追加失败')
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
      await streamChat(nextMessages, onEvent, controller.signal)
    } catch (e) {
      if (controller.signal.aborted) {
        appendToAssistant((c) => c + '\n\n[已中止]')
      } else {
        appendToAssistant((c) => c + `\n\n[错误] ${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
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
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '新建会话失败')
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', maxWidth: 960, width: '100%', margin: '0 auto', padding: 16, boxSizing: 'border-box', minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: '#888' }}>{notice ?? ''}</span>
        <button onClick={newSession} disabled={streaming} style={{ fontSize: 12 }}>新会话</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 8, padding: 16, background: '#fff', minHeight: 0 }}>
        {!route && <p style={{ color: '#888' }}>请先在顶部选择分组和模型。</p>}
        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            <strong>{msg.role === 'user' ? '你' : '助手'}:</strong>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{msg.content || (streaming && i === messages.length - 1 ? '…' : '')}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
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
  )
}
