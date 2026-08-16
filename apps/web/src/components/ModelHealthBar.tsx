import { useCallback, useEffect, useState } from 'react'
import { api, ModelHealthCell, ModelHealthInfo } from '../api'

/** Uptime-style status strip for the selected route, fed by the credential
 *  proxy's observations of every real request: 绿=正常 紫=有问题(部分失败)
 *  红=无法使用(全部失败) 灰=该时段无请求. */

const CELL_STYLES: Record<ModelHealthCell['state'], { background: string; border?: string }> = {
  ok: { background: '#2da44e' },
  warn: { background: '#8250df' },
  error: { background: '#cf222e' },
  idle: { background: '#ebedf0', border: '1px solid #d0d7de' }
}

interface ModelHealthBarProps {
  group: string
  model: string
}

export default function ModelHealthBar({ group, model }: ModelHealthBarProps) {
  const [health, setHealth] = useState<ModelHealthInfo | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.modelHealth(group, model)
      setHealth(res.health)
    } catch {
      // 状态条属于附加信息,加载失败不打扰主流程。
    }
  }, [group, model])

  useEffect(() => {
    setHealth(null)
    load()
    const interval = setInterval(load, 60_000)
    return () => clearInterval(interval)
  }, [load])

  useEffect(() => {
    const onTurn = () => { load() }
    window.addEventListener('botcf:turn-complete', onTurn)
    return () => window.removeEventListener('botcf:turn-complete', onTurn)
  }, [load])

  if (!health) return null

  const hours = Math.round(health.windowMs / 3_600_000)
  const cellLabel = (cell: ModelHealthCell): string => {
    const time = new Date(cell.start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    if (cell.total === 0) return `${time} 起 无请求`
    return `${time} 起 ${cell.total} 次请求,失败 ${cell.failed}`
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, color: '#666', flexWrap: 'wrap' }}>
      <span title="绿=正常 紫=有问题(部分失败) 红=无法使用(全部失败) 灰=该时段无请求">
        模型状态(近 {hours} 小时,本机实测):
      </span>
      <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
        {health.cells.map((cell) => (
          <span
            key={cell.start}
            title={cellLabel(cell)}
            style={{ width: 7, height: 14, borderRadius: 2, boxSizing: 'border-box', ...CELL_STYLES[cell.state] }}
          />
        ))}
      </span>
      <span>
        故障率 {health.faultRate === null ? '—(窗口内无请求)' : `${(health.faultRate * 100).toFixed(1)}%`}
        {health.total > 0 && <> ({health.failed}/{health.total} 次失败)</>}
      </span>
    </div>
  )
}
