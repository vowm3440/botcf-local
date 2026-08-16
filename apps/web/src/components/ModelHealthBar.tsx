import { useCallback, useEffect, useState } from 'react'
import { api, ModelHealthCell, ModelHealthInfo, SiteHealthMeta, SiteModelHealthInfo } from '../api'

/** Route status like botcf.com/pricing: site-wide cells first (the same data
 *  the official page renders), local proxy observations as the second row.
 *  颜色:绿=正常 紫=有问题(部分失败) 红=无法使用(全部失败) 灰=无人在使用. */

const CELL_STYLES: Record<ModelHealthCell['state'], { background: string; border?: string }> = {
  ok: { background: '#2da44e' },
  warn: { background: '#8250df' },
  error: { background: '#cf222e' },
  idle: { background: '#ebedf0', border: '1px solid #d0d7de' }
}

const LEGEND = '绿=正常 紫=有问题(部分失败) 红=无法使用(全部失败) 灰=无人在使用'

function Cells({ cells, size }: { cells: ModelHealthCell[]; size: 'lg' | 'sm' }) {
  const [width, height] = size === 'lg' ? [10, 18] : [7, 13]
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
      {cells.map((cell) => {
        const time = new Date(cell.start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        const label = cell.total === 0 ? `${time} 起 无请求` : `${time} 起 ${cell.total} 次请求,失败 ${cell.failed}`
        return (
          <span
            key={cell.start}
            title={label}
            style={{ width, height, borderRadius: 2, boxSizing: 'border-box', ...CELL_STYLES[cell.state] }}
          />
        )
      })}
    </span>
  )
}

function rateText(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

interface ModelHealthBarProps {
  group: string
  model: string
}

export default function ModelHealthBar({ group, model }: ModelHealthBarProps) {
  const [health, setHealth] = useState<ModelHealthInfo | null>(null)
  const [site, setSite] = useState<SiteModelHealthInfo | null>(null)
  const [siteMeta, setSiteMeta] = useState<SiteHealthMeta | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.modelHealth(group, model)
      setHealth(res.health)
      setSite(res.site)
      setSiteMeta(res.siteMeta)
    } catch {
      // 状态条属于附加信息,加载失败不打扰主流程。
    }
  }, [group, model])

  useEffect(() => {
    setHealth(null)
    setSite(null)
    setSiteMeta(null)
    load()
    const interval = setInterval(load, 30_000)
    return () => clearInterval(interval)
  }, [load])

  useEffect(() => {
    const onTurn = () => { load() }
    window.addEventListener('botcf:turn-complete', onTurn)
    return () => window.removeEventListener('botcf:turn-complete', onTurn)
  }, [load])

  if (!health && !site) return null

  const siteMinutes = site && site.cells.length > 0
    ? Math.max(1, Math.round((site.cells.length * (siteMeta?.bucketMs ?? 60_000)) / 60_000))
    : null
  const localHours = health ? Math.round(health.windowMs / 3_600_000) : 0

  return (
    <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
      {site && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} title={LEGEND}>
          <span>网站全站{siteMinutes ? `(近 ${siteMinutes} 分钟)` : ''}:</span>
          {site.cells.length > 0 && <Cells cells={site.cells} size="lg" />}
          <span>
            {site.requests === 0
              ? '无人在使用'
              : <>故障率 {rateText(site.errorRate)} ({site.errors}/{site.requests} 次失败)</>}
          </span>
          {site.avgTtftSeconds !== null && <span>首字 {site.avgTtftSeconds.toFixed(2)}s</span>}
          {site.throughputTps !== null && <span>{site.throughputTps.toFixed(1)} tok/s</span>}
        </div>
      )}
      {health && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: site ? 4 : 0 }} title={LEGEND}>
          <span>本机实测(近 {localHours} 小时):</span>
          <Cells cells={health.cells} size="sm" />
          <span>
            故障率 {health.faultRate === null ? '—(无请求)' : `${(health.faultRate * 100).toFixed(1)}%`}
            {health.total > 0 && <> ({health.failed}/{health.total} 次失败)</>}
          </span>
          {!site && health.total === 0 && (
            <span style={{ color: '#999' }}>网站全站状态暂不可达;本机每次真实对话都会着色</span>
          )}
        </div>
      )}
    </div>
  )
}
