import type { ReactNode } from 'react'
import { chromeSurface, color, metric, text } from '../design/tokens'
import type { RouteInfo } from '../api'
import type { ContextUsage } from '../chat/useChatSession'
import { diffColor } from '../editor/diffPalette'
import type { DiffCounts } from '../editor/editRegions'

/** The status strip: the numbers that were once scattered across panel footers and
 *  toggle badges, in the one row that is always visible.
 *
 *  Left is the state of the project (problems, pending review, connection mode);
 *  right is the state of the conversation (tokens, context, route). Counters are
 *  buttons wherever there is somewhere to go — clicking 问题 brings that part
 *  forward, which is the whole reason a count belongs in a status bar rather than in
 *  a tooltip.
 *
 *  Quiet on purpose. The previous strip was a full-width band of accent blue, which
 *  is a lot of the brightest colour on screen spent on numbers that are usually
 *  zero. Here the accent is kept for the things the user is acting on, and the strip
 *  earns attention only when something is actually wrong. */

export interface StatusBarProps {
  route: RouteInfo | null
  ompRunning: boolean
  streaming: boolean
  sessionTokens: { input: number; output: number }
  contextUsage: ContextUsage | null
  problems: { errors: number; warnings: number }
  review: { pending: number; failed: number }
  openTabs: number
  /** Files the assistant changed this session, and the lines it wrote in them. */
  aiEdits: DiffCounts & { files: number }
  onOpenProblems: () => void
  onOpenReview: () => void
  /** The AI-edit counter goes to the explorer, which lists the changed files. */
  onOpenExplorer: () => void
}

interface ItemProps {
  title: string
  children: ReactNode
  onClick?: () => void
  tone?: 'normal' | 'alert'
}

function StatusItem({ title, children, onClick, tone = 'normal' }: ItemProps) {
  if (!onClick) {
    return (
      <span className="dock-status-item" data-tone={tone} title={title}>
        {children}
      </span>
    )
  }
  return (
    <button type="button" className="dock-status-item" data-tone={tone} title={title} onClick={onClick}>
      {children}
    </button>
  )
}

/** A filled dot, for states that are either on or off. Colour carries the meaning,
 *  the label carries the detail. */
function Dot({ tone }: { tone: string }) {
  return (
    <span
      aria-hidden
      style={{ width: 6, height: 6, borderRadius: '50%', background: tone, flex: 'none' }}
    />
  )
}

export default function StatusBar({
  route,
  ompRunning,
  streaming,
  sessionTokens,
  contextUsage,
  problems,
  review,
  openTabs,
  aiEdits,
  onOpenProblems,
  onOpenReview,
  onOpenExplorer
}: StatusBarProps) {
  const hasErrors = problems.errors > 0
  return (
    <footer
      aria-label="状态栏"
      style={{
        ...chromeSurface,
        ...text.micro,
        flex: 'none',
        height: metric.statusHeight,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'stretch',
        padding: '0 4px',
        color: color.ink2,
        borderTop: `1px solid ${color.line}`,
        overflow: 'hidden'
      }}
    >
      <StatusItem
        title="错误与警告 — 点击打开问题面板"
        onClick={onOpenProblems}
        tone={hasErrors ? 'alert' : 'normal'}
      >
        {hasErrors && <Dot tone={color.red} />}
        {problems.errors} 错误 · {problems.warnings} 警告
      </StatusItem>
      <StatusItem
        title={review.failed > 0 ? `${review.failed} 个文件应用失败 — 点击打开审查` : '等待审查的文件 — 点击打开审查'}
        onClick={onOpenReview}
        tone={review.failed > 0 ? 'alert' : 'normal'}
      >
        审查 {review.pending}
        {review.failed > 0 ? ` · 失败 ${review.failed}` : ''}
      </StatusItem>
      <StatusItem title={ompRunning ? '通过 OMP 运行时执行工具与会话' : '直连模型,不经过 OMP 运行时'}>
        {ompRunning ? 'OMP 会话' : '直连模式'}
      </StatusItem>
      {streaming && (
        <StatusItem title="正在生成回复">
          <Dot tone={color.accent} />
          生成中
        </StatusItem>
      )}

      <span style={{ flex: 1 }} />

      {aiEdits.files > 0 && (
        <StatusItem
          title={`本会话 AI 改动了 ${aiEdits.files} 个文件,共 +${aiEdits.added} −${aiEdits.removed} 行 — 点击打开资源管理器`}
          onClick={onOpenExplorer}
        >
          AI {aiEdits.files} 文件
          <span style={{ color: diffColor.addInk }}>+{aiEdits.added}</span>
          <span style={{ color: diffColor.delInk }}>−{aiEdits.removed}</span>
        </StatusItem>
      )}
      {openTabs > 0 && <StatusItem title="编辑器中打开的标签数">{openTabs} 个标签</StatusItem>}
      <StatusItem title="本会话累计 Token">
        ↑{sessionTokens.input.toLocaleString()} ↓{sessionTokens.output.toLocaleString()}
      </StatusItem>
      {contextUsage && (
        <StatusItem
          title={`上下文 ${contextUsage.tokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()}`}
        >
          上下文 {contextUsage.percent.toFixed(1)}%
        </StatusItem>
      )}
      {route && (
        <StatusItem title={`${route.group} · ${route.modelId}`}>
          {route.apiType} · {route.capabilityLabel}
        </StatusItem>
      )}
    </footer>
  )
}
