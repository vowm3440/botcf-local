import type { ModelHealthCell } from '../../api'
import { CAPTION, CHROME, NUMERIC } from './chrome'
import type { ModelHealth } from './useModelHealth'

/** Model health, twice: a pulse in the bar and the same data spelled out in the
 *  menu.
 *
 *  The bar gets ten bars and one number, because health is a thing you check
 *  peripherally — a shape that stops being green is enough to make you look. The
 *  words (window, sample size, first-token latency, the legend) live in the
 *  tooltip and in the menu, where there is room to be unambiguous.
 *
 *  Colours follow botcf.com/pricing so the two never disagree: green is below the
 *  site's fault threshold, purple has reached it, red is total failure. */

const CELL_COLORS: Record<ModelHealthCell['state'], string> = {
  ok: '#2da44e',
  warn: '#8250df',
  error: '#cf222e',
  idle: 'rgba(140,149,159,.30)'
}

const SITE_LEGEND = '与 botcf.com/pricing 一致:绿=低于官网故障阈值 紫=达到阈值 红=全部失败 灰=无调用'
const LOCAL_LEGEND = '本机实测:绿=全部成功 紫=部分失败 红=全部失败 灰=无请求'

const PULSE_HEIGHT = 14
const IDLE_HEIGHT = 4

function minuteLabel(start: number): string {
  if (!start) return '未知分钟'
  return new Date(start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function percent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

function metric(value: number | null, suffix: string): string | null {
  if (value === null || !Number.isFinite(value)) return null
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded}${suffix}`
}

/** Healthy minutes are drawn tallest; a rising fault rate shortens the bar, so
 *  degradation is visible before the colour changes. */
function cellHeight(cell: ModelHealthCell, thresholdPercent: number): number {
  if (cell.state === 'idle') return IDLE_HEIGHT
  if (cell.state !== 'ok' || thresholdPercent <= 0) return PULSE_HEIGHT
  const ratePercent = Math.max(0, Math.min(thresholdPercent, (cell.errorRate ?? 0) * 100))
  return Math.max(8, Math.round(PULSE_HEIGHT - (ratePercent / thresholdPercent) * 6))
}

function cellTitle(cell: ModelHealthCell): string {
  const at = minuteLabel(cell.start)
  if (cell.total === 0) return `${at} 无调用`
  const rate = ((cell.errorRate ?? cell.failed / cell.total) * 100).toFixed(1)
  return `${at} · ${cell.total} 次 · 错误率 ${rate}%`
}

interface PulseProps {
  cells: ModelHealthCell[]
  /** The site's display threshold; 0 keeps every non-idle bar full height. */
  thresholdPercent?: number
  limit?: number
}

function Pulse({ cells, thresholdPercent = 0, limit = 10 }: PulseProps) {
  const shown = cells.slice(-limit)
  return (
    <span
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'flex-end',
        justifyContent: 'flex-end',
        gap: 1,
        height: PULSE_HEIGHT,
        width: limit * 4 - 1
      }}
    >
      {shown.map((cell, index) => (
        <span
          key={`${cell.start}-${index}`}
          title={cellTitle(cell)}
          style={{
            flex: '0 0 3px',
            width: 3,
            height: cellHeight(cell, thresholdPercent),
            borderRadius: 999,
            background: CELL_COLORS[cell.state]
          }}
        />
      ))}
    </span>
  )
}

function siteMinutes(health: ModelHealth): number {
  const meta = health.siteMeta
  return meta ? Math.max(1, Math.round((meta.bucketCount * meta.bucketMs) / 60_000)) : 10
}

function localHours(health: ModelHealth): number {
  return health.local ? Math.round(health.local.windowMs / 3_600_000) : 0
}

/** Everything the pulse leaves out, as a tooltip. */
function pulseTitle(health: ModelHealth): string {
  const lines: string[] = []
  const { site, local } = health
  if (site) {
    lines.push(
      site.requests > 0
        ? `站点近 ${siteMinutes(health)} 分钟 · 成功率 ${percent(site.successRate)} · ${site.requests} 次 · ${site.errors} 错误`
        : `站点近 ${siteMinutes(health)} 分钟 · 暂无调用`
    )
    const ttft = metric(site.avgTtftSeconds, 's')
    const tps = metric(site.throughputTps, ' tok/s')
    if (ttft || tps) lines.push(['首字延迟 ' + (ttft ?? '—'), tps ? `吞吐 ${tps}` : null].filter(Boolean).join(' · '))
    lines.push(SITE_LEGEND)
  }
  if (local) {
    lines.push(
      local.total > 0
        ? `本机近 ${localHours(health)} 小时 · 故障率 ${percent(local.faultRate)} · ${local.failed}/${local.total} 次失败`
        : `本机近 ${localHours(health)} 小时 · 无请求`
    )
    if (!site) lines.push(LOCAL_LEGEND)
  }
  if (health.siteMeta?.generatedAt) {
    lines.push(`站点数据更新于 ${new Date(health.siteMeta.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`)
  }
  return lines.join('\n')
}

function rateInk(rate: number | null): string {
  if (rate === null) return CHROME.inkTertiary
  if (rate >= 0.99) return CHROME.ink
  if (rate >= 0.9) return CHROME.warn
  return CHROME.danger
}

/** In-bar health: ten bars, one number, one word of provenance. */
export function HealthPulse({ health }: { health: ModelHealth }) {
  const { site, local } = health
  if (!site && !local) return null

  const fromSite = Boolean(site)
  const cells = site ? site.cells : (local?.cells ?? [])
  const successRate = site
    ? site.requests > 0
      ? site.successRate
      : null
    : local && local.total > 0
      ? 1 - (local.faultRate ?? 0)
      : null

  return (
    <span
      title={pulseTitle(health)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}
    >
      <span style={CAPTION}>{fromSite ? '站点' : '本机'}</span>
      <Pulse cells={cells} thresholdPercent={site?.displayErrorThreshold ?? 0} />
      <span style={{ fontSize: 12, color: rateInk(successRate), ...NUMERIC }}>
        {successRate === null ? '暂无调用' : percent(successRate)}
      </span>
    </span>
  )
}

interface DetailRowProps {
  label: string
  cells: ModelHealthCell[]
  thresholdPercent?: number
  limit?: number
  value: string
  title: string
}

function DetailRow({ label, cells, thresholdPercent, limit, value, title }: DetailRowProps) {
  return (
    <div title={title} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
      <span style={{ ...CAPTION, flex: 'none', width: 92 }}>{label}</span>
      <Pulse cells={cells} thresholdPercent={thresholdPercent} limit={limit} />
      <span style={{ flex: 1, textAlign: 'right', fontSize: 12, color: CHROME.inkSecondary, ...NUMERIC }}>{value}</span>
    </div>
  )
}

/** The same numbers, spelled out — for the menu, where reading is the point. */
export function HealthDetail({ health }: { health: ModelHealth }) {
  const { site, local } = health
  if (!site && !local) return <div style={CAPTION}>正在读取模型状态…</div>

  const ttft = site ? metric(site.avgTtftSeconds, 's') : null
  return (
    <>
      {site && (
        <DetailRow
          label={`站点 · 近 ${siteMinutes(health)} 分`}
          cells={site.cells}
          thresholdPercent={site.displayErrorThreshold}
          value={
            site.requests > 0
              ? [percent(site.successRate), `${site.requests} 次`, ttft ? `首字 ${ttft}` : null]
                  .filter(Boolean)
                  .join(' · ')
              : '暂无调用'
          }
          title={SITE_LEGEND}
        />
      )}
      {local && (
        <DetailRow
          label={`本机 · 近 ${localHours(health)} 时`}
          cells={local.cells}
          limit={16}
          value={
            local.total > 0
              ? `故障 ${percent(local.faultRate)} · ${local.failed}/${local.total} 失败`
              : '无请求'
          }
          title={LOCAL_LEGEND}
        />
      )}
      {!site && local?.total === 0 && (
        <div style={{ ...CAPTION, paddingTop: 2 }}>站点状态暂不可达;本机每次真实对话都会着色</div>
      )}
    </>
  )
}
