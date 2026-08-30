import { CAPTION, CHROME, NUMERIC } from './chrome'
import type { LastRequestData, UsageData } from './useTopBarData'

/** Balance, with the quota it came out of drawn underneath.
 *
 *  The old bar printed "余额 $12.40 / 已用 $37.60" and made you divide. One number
 *  plus a 3px meter says the same thing without arithmetic: the figure you spend
 *  is the figure you read, and the bar answers "how far in am I" peripherally,
 *  turning amber then red as the quota runs down. Everything else — last request,
 *  refresh time — is a tooltip, and the full breakdown lives in the menu. */

export interface BalanceMeterProps {
  usage: UsageData | null
  refreshedAt: number | null
  lastRequest: LastRequestData | null
}

const METER_WIDTH = 72

function meterInk(usedFraction: number): string {
  if (usedFraction >= 0.95) return CHROME.danger
  if (usedFraction >= 0.8) return CHROME.warn
  return CHROME.accent
}

export function usedFractionOf(usage: UsageData): number {
  const total = usage.quotaUsd + usage.usedQuotaUsd
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, usage.usedQuotaUsd / total))
}

export default function BalanceMeter({ usage, refreshedAt, lastRequest }: BalanceMeterProps) {
  if (!usage) {
    return (
      <span style={CAPTION} title="额度尚未同步">
        余额 —
      </span>
    )
  }

  const used = usedFractionOf(usage)
  const title = [
    `余额 $${usage.quotaUsd.toFixed(2)} · 已用 $${usage.usedQuotaUsd.toFixed(2)}(${Math.round(used * 100)}%)`,
    lastRequest
      ? `上次请求 $${lastRequest.costUsd.toFixed(4)} · ${lastRequest.promptTokens}+${lastRequest.completionTokens} tok · ${lastRequest.model}`
      : null,
    refreshedAt ? `${new Date(refreshedAt).toLocaleTimeString()} 已刷新` : null
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <span
      title={title}
      style={{ flex: 'none', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
        <span style={CAPTION}>余额</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: CHROME.ink, ...NUMERIC }}>
          ${usage.quotaUsd.toFixed(2)}
        </span>
      </span>
      <span
        aria-hidden
        style={{
          width: METER_WIDTH,
          height: 3,
          borderRadius: 999,
          background: 'rgba(27,31,36,.10)',
          overflow: 'hidden'
        }}
      >
        <span
          style={{
            display: 'block',
            width: `${Math.max(used > 0 ? 2 : 0, used * 100)}%`,
            height: '100%',
            borderRadius: 999,
            background: meterInk(used)
          }}
        />
      </span>
    </span>
  )
}
