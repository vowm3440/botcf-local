import { useEffect, useRef } from 'react'
import type { AccessMode, ChangedFileInfo, RouteInfo } from '../api'
import ChatInput from './ChatInput'
import ReasoningBlock from './ReasoningBlock'
import ToolCard from './ToolCard'
import { BUTTON, MONO, PANEL_BODY, SELECT, STATUS_LINE, TOOLBAR } from './ui'
import { color, font, radius, text } from '../design/tokens'
import type { ChatSessionApi } from '../chat/useChatSession'
import type { TranscriptNotice } from '../chat/messages'

/** The assistant pane, in the secondary sidebar.
 *
 *  Presentation only — the conversation itself lives in useChatSession, because
 *  three other parts of the workbench read from it. What is left here is the
 *  transcript, the composer, and the one piece of state that is genuinely about
 *  looking at it: whether to follow the stream to the bottom.
 *
 *  A turn is shown in the order the runtime produced it: what it thought, the
 *  lines it would have printed to a terminal, the tools it ran, what it wrote,
 *  and the files that changed. Anything the runtime reports and this pane drops
 *  becomes a silent pause, which is the one failure mode a chat pane cannot
 *  afford. */

export interface ChatViewProps {
  session: ChatSessionApi
  route: RouteInfo | null
  ompRunning: boolean
  /** Tool-approval mode, shown in the composer so it is never a mystery. */
  accessMode: AccessMode
  /** False while the pane is hidden; a hidden element cannot be scrolled. */
  active: boolean
  onOpenFile: (path: string) => void
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
          style={{
            marginLeft: 6,
            marginTop: 4,
            fontFamily: MONO,
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 4,
            cursor: 'pointer',
            border: `1px solid ${file.isError ? '#efb4b4' : '#cfe3cf'}`,
            background: file.isError ? '#fff2f0' : '#f2fbf2',
            color: file.isError ? '#cf222e' : '#2a7d46'
          }}
        >
          {file.path}
        </button>
      ))}
    </div>
  )
}

/** Run chrome — compaction, retries, auto-approvals, a truncated answer. Styled
 *  as terminal lines rather than prose, because that is what they are. */
function NoticeLines({ notices }: { notices: TranscriptNotice[] }) {
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {notices.map((notice, index) => (
        <div
          key={`${index}-${notice.text}`}
          style={{
            ...text.micro,
            fontFamily: font.mono,
            color: notice.level === 'warn' ? color.amber : color.ink3,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {notice.level === 'warn' ? '! ' : '· '}
          {notice.text}
        </div>
      ))}
    </div>
  )
}

/** One footer chip in the composer. */
function Chip({ label, title, tone = 'muted' }: { label: string; title: string; tone?: 'muted' | 'warn' }) {
  return (
    <span
      title={title}
      style={{
        ...text.micro,
        flex: 'none',
        maxWidth: 160,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        padding: '1px 6px',
        borderRadius: radius.pill,
        border: `1px solid ${tone === 'warn' ? color.amber : color.line}`,
        color: tone === 'warn' ? color.amber : color.ink3
      }}
    >
      {label}
    </span>
  )
}

export default function ChatView({ session, route, ompRunning, accessMode, active, onOpenFile }: ChatViewProps) {
  const { messages, streaming, notice } = session
  const listRef = useRef<HTMLDivElement | null>(null)
  /** Follow streaming output unless the user scrolled up to read. */
  const stickToBottom = useRef(true)

  const onListScroll = (): void => {
    const el = listRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  // While hidden (display:none) scrollHeight is 0 and scrolling is a no-op, so
  // becoming visible again has to catch up on everything that arrived meanwhile.
  useEffect(() => {
    if (!active) return
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, active])

  const send = (): void => {
    stickToBottom.current = true
    session.send().catch(() => undefined)
  }

  const placeholder = !route
    ? '未选择路由'
    : streaming
      ? ompRunning
        ? '输入内容回车可追加引导…'
        : '生成中…'
      : '输入消息…'

  const lastIndex = messages.length - 1

  return (
    <div style={PANEL_BODY}>
      <div style={TOOLBAR}>
        {ompRunning && (
          <select
            aria-label="会话"
            value={session.currentSessionPath}
            onChange={(event) => session.switchSession(event.target.value).catch(() => undefined)}
            disabled={streaming}
            style={{ ...SELECT, flex: 1, maxWidth: 'none' }}
          >
            {session.currentSessionPath && !session.sessions.some((entry) => entry.path === session.currentSessionPath) && (
              <option value={session.currentSessionPath}>当前新会话</option>
            )}
            {!session.currentSessionPath && <option value="">当前会话</option>}
            {session.sessions.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.title || entry.preview || new Date(entry.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => session.newSession().catch(() => undefined)}
          disabled={streaming}
          style={BUTTON}
          title="开始一个空会话"
        >
          新会话
        </button>
      </div>

      {notice && <div style={STATUS_LINE}>{notice}</div>}

      <div ref={listRef} onScroll={onListScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {!route && <p style={{ color: '#888', fontSize: 12 }}>请先在顶部选择分组和模型。</p>}
        {messages.map((message, index) => {
          const isLive = streaming && index === lastIndex
          // Thinking stands in for the answer until the answer exists; once it
          // does, the reasoning folds away instead of pushing it off screen.
          const showsReasoning = Boolean(message.reasoning)
          const nothingElseYet = message.content === '' && !message.tools?.length
          return (
            <div key={index} style={{ marginBottom: 14 }}>
              <strong style={{ fontSize: 12 }}>{message.role === 'user' ? '你' : '助手'}:</strong>
              {showsReasoning && (
                <ReasoningBlock
                  reasoning={message.reasoning ?? ''}
                  expanded={isLive && nothingElseYet}
                  live={isLive}
                />
              )}
              {message.content !== '' && (
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 4, fontSize: 13 }}>
                  {message.content}
                </div>
              )}
              {isLive && nothingElseYet && !showsReasoning && (
                <div style={{ ...text.body, marginTop: 4, color: color.ink3 }}>…</div>
              )}
              {message.notices && message.notices.length > 0 && <NoticeLines notices={message.notices} />}
              {message.tools?.map((tool) => (
                <ToolCard key={tool.id} tool={tool} />
              ))}
              {message.changedFiles && message.changedFiles.length > 0 && (
                <ChangedFilesRow files={message.changedFiles} onOpen={onOpenFile} />
              )}
            </div>
          )
        })}
      </div>

      <div style={{ padding: 8, borderTop: `1px solid ${color.line}`, minWidth: 0 }}>
        <ChatInput
          value={session.input}
          onChange={session.setInput}
          onSubmit={send}
          onAbort={session.abort}
          disabled={!route || (streaming && !ompRunning)}
          placeholder={placeholder}
          streaming={streaming}
          canSteer={ompRunning}
          chips={
            route ? (
              <>
                <Chip label={route.modelId} title={`分组 ${route.group} · ${route.capabilityLabel}`} />
                {route.thinkingLevel && (
                  <Chip label={`思考 ${route.thinkingLevel}`} title="思考等级,在顶栏路由处更改" />
                )}
                <Chip
                  label={accessMode === 'full' ? '完全访问' : '确认模式'}
                  title={
                    accessMode === 'full'
                      ? '工具确认由本机自动允许,运行不会中途停下(在顶栏 ⚙ → 权限里更改)'
                      : '工具确认会弹窗询问你(在顶栏 ⚙ → 权限里更改)'
                  }
                  tone={accessMode === 'full' ? 'warn' : 'muted'}
                />
              </>
            ) : (
              <Chip label="未选择路由" title="先在顶栏选择分组与模型" />
            )
          }
        />
      </div>
    </div>
  )
}
