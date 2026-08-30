import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ModelHealthCell, ModelHealthInfo, SiteHealthMeta, SiteModelHealthInfo } from '../api'

const WEBSITE_REFRESH_MS = 15_000
const OFFICIAL_COLORS: Record<ModelHealthCell['state'], string> = {
  ok: '#10b981',
  warn: '#a855f7',
  error: '#ef4444',
  idle: 'rgba(148, 163, 184, .34)'
}
const LOCAL_STYLES: Record<ModelHealthCell['state'], { background: string; border?: string }> = {
  ok: { background: '#2da44e' },
  warn: { background: '#8250df' },
  error: { background: '#cf222e' },
  idle: { background: '#ebedf0', border: '1px solid #d0d7de' }
}

const OFFICIAL_LEGEND = '与 botcf.com/pricing 一致: 绿=低于官网故障阈值 紫=达到阈值 红=全部失败 灰=无调用'
const LOCAL_LEGEND = '本机实测: 绿=全部成功 紫=部分失败 红=全部失败 灰=无请求'

function minuteLabel(start: number): string {
  if (!start) return '未知分钟'
  return new Date(start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function officialHeight(cell: ModelHealthCell, thresholdPercent: number): number {
  if (cell.state === 'idle') return 6
  if (cell.state !== 'ok' || thresholdPercent <= 0) return 16
  const ratePercent = Math.max(0, Math.min(thresholdPercent, (cell.errorRate ?? 0) * 100))
  return Math.max(9, Math.round(16 - (ratePercent / thresholdPercent) * 7))
}

function OfficialCells({ cells, thresholdPercent }: { cells: ModelHealthCell[]; thresholdPercent: number }) {
  return (
    <span style={{ width: 39, height: 16, display: 'inline-flex', alignItems: 'flex-end', justifyContent: 'flex-end', gap: 1 }}>
      {cells.slice(-10).map((cell, index) => {
        const detail = cell.total > 0
          ? `${minuteLabel(cell.start)} · 错误率 ${((cell.errorRate ?? cell.failed / cell.total) * 100).toFixed(1)}% · ${cell.total} 次`
          : `${minuteLabel(cell.start)} · 无调用`
        return (
          <span
            key={`${cell.start}-${index}`}
            title={detail}
            style={{
              flex: '0 0 3px',
              width: 3,
              minWidth: 3,
              height: officialHeight(cell, thresholdPercent),
              borderRadius: 999,
              background: OFFICIAL_COLORS[cell.state]
            }}
          />
        )
      })}
    </span>
  )
}

function LocalCells({ cells }: { cells: ModelHealthCell[] }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
      {cells.map((cell, index) => {
        const time = minuteLabel(cell.start)
        const label = cell.total === 0 ? `${time} 起 无请求` : `${time} 起 ${cell.total} 次请求,失败 ${cell.failed}`
        return (
          <span
            key={`${cell.start}-${index}`}
            title={label}
            style={{ width: 7, height: 13, borderRadius: 2, boxSizing: 'border-box', ...LOCAL_STYLES[cell.state] }}
          />
        )
      })}
    </span>
  )
}

function percentage(rate: number | null): string {
  return rate === null ? '--' : `${(rate * 100).toFixed(1)}%`
}

function websiteMetric(value: number | null, suffix: string): string {
  if (value === null || !Number.isFinite(value)) return '--'
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded}${suffix}`
}

interface ModelHealthBarProps {
  group: string
  model: string
}

export default function ModelHealthBar({ group, model }: ModelHealthBarProps) {
  const [health, setHealth] = useState<ModelHealthInfo | null>(null)
  const [site, setSite] = useState<SiteModelHealthInfo | null>(null)
  const [siteMeta, setSiteMeta] = useState<SiteHealthMeta | null>(null)
  const refreshMs = useRef(WEBSITE_REFRESH_MS)

  const load = useCallback(async () => {
    try {
      const res = await api.modelHealth(group, model)
      setHealth(res.health)
      setSite(res.site)
      setSiteMeta(res.siteMeta)
      refreshMs.current = res.siteMeta?.refreshMs
        ? Math.max(5_000, Math.min(300_000, res.siteMeta.refreshMs))
        : WEBSITE_REFRESH_MS
    } catch {
      // Health is supplementary; keep the last successful snapshot on errors.
    }
  }, [group, model])

  useEffect(() => {
    let stopped = false
    let timer = 0
    setHealth(null)
    setSite(null)
    setSiteMeta(null)
    refreshMs.current = WEBSITE_REFRESH_MS

    const poll = async () => {
      await load()
      if (!stopped) timer = window.setTimeout(poll, refreshMs.current)
    }
    poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [load])

  useEffect(() => {
    const onTurn = () => { load() }
    window.addEventListener('botcf:turn-complete', onTurn)
    return () => window.removeEventListener('botcf:turn-complete', onTurn)
  }, [load])

  if (!health && !site) return null

  const siteMinutes = siteMeta
    ? Math.max(1, Math.round((siteMeta.bucketCount * siteMeta.bucketMs) / 60_000))
    : 10
  const localHours = health ? Math.round(health.windowMs / 3_600_000) : 0
  const generated = siteMeta?.generatedAt
    ? new Date(siteMeta.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '未知'
  const officialTitle = site
    ? [
        site.requests > 0
          ? `近${siteMinutes}分钟成功率 ${percentage(site.successRate)} · ${site.requests} 次 · ${site.errors} 错误`
          : `近${siteMinutes}分钟暂无调用`,
        `更新 ${generated}`,
        OFFICIAL_LEGEND
      ].join('\n')
    : OFFICIAL_LEGEND

  return (
    <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
      {site && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} title={officialTitle}>
          <span>网站(近 {siteMinutes} 分钟):</span>
          <span>首字 {websiteMetric(site.avgTtftSeconds, 's')}</span>
          <span>状态</span>
          <OfficialCells cells={site.cells} thresholdPercent={site.displayErrorThreshold} />
          <span>{site.requests > 0 ? `成功率 ${percentage(site.successRate)}` : '暂无调用'}</span>
        </div>
      )}
      {health && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: site ? 4 : 0 }} title={LOCAL_LEGEND}>
          <span>本机实测(近 {localHours} 小时):</span>
          <LocalCells cells={health.cells} />
          <span>
            故障率 {health.faultRate === null ? '--(无请求)' : `${(health.faultRate * 100).toFixed(1)}%`}
            {health.total > 0 && <> ({health.failed}/{health.total} 次失败)</>}
          </span>
          {!site && health.total === 0 && (
            <span style={{ color: '#999' }}>网站状态暂不可达;本机每次真实对话都会着色</span>
          )}
        </div>
      )}
    </div>
  )
}
