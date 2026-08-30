import { FormEvent } from 'react'
import { GroupInfo } from '../api'

export interface LogFilterValues {
  start: string
  end: string
  group: string
  tokenName: string
  modelName: string
}

interface LogFiltersProps {
  value: LogFilterValues
  groups: GroupInfo[]
  loading: boolean
  onChange: (value: LogFilterValues) => void
  onApply: () => void
  onReset: () => void
}

export function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function recentRange(days: number): Pick<LogFilterValues, 'start' | 'end'> {
  const end = new Date()
  const start = new Date(end)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - Math.max(0, days - 1))
  return { start: localDateTimeValue(start), end: localDateTimeValue(end) }
}

export default function LogFilters({ value, groups, loading, onChange, onApply, onReset }: LogFiltersProps) {
  const update = (patch: Partial<LogFilterValues>) => onChange({ ...value, ...patch })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onApply()
  }

  const inputStyle = { minHeight: 34, border: '1px solid #c9c9c9', borderRadius: 5, padding: '5px 8px', boxSizing: 'border-box' as const }
  const labelStyle = { display: 'flex', flexDirection: 'column' as const, gap: 4, minWidth: 160, fontSize: 12, color: '#555' }

  return (
    <form onSubmit={submit} style={{ padding: '12px 16px', borderBottom: '1px solid #e1e1e1', background: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <label style={labelStyle}>
          开始时间
          <input type="datetime-local" value={value.start} onChange={(event) => update({ start: event.target.value })} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          结束时间
          <input type="datetime-local" value={value.end} onChange={(event) => update({ end: event.target.value })} style={inputStyle} />
        </label>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', minHeight: 34 }}>
          {[
            { label: '今天', days: 1 },
            { label: '近 7 天', days: 7 },
            { label: '近 30 天', days: 30 }
          ].map((preset) => (
            <button key={preset.days} type="button" onClick={() => update(recentRange(preset.days))} style={{ minHeight: 30, borderRadius: 5, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}>
              {preset.label}
            </button>
          ))}
        </div>
        <label style={{ ...labelStyle, minWidth: 140 }}>
          分组
          <select value={value.group} onChange={(event) => update({ group: event.target.value })} style={inputStyle}>
            <option value="">全部分组</option>
            {groups.map((group) => <option key={group.name} value={group.name}>{group.name}</option>)}
          </select>
        </label>
        <label style={{ ...labelStyle, minWidth: 180, flex: 1 }}>
          令牌名
          <input value={value.tokenName} onChange={(event) => update({ tokenName: event.target.value })} placeholder="全部令牌" style={{ ...inputStyle, width: '100%' }} />
        </label>
        <label style={{ ...labelStyle, minWidth: 180, flex: 1 }}>
          模型名
          <input value={value.modelName} onChange={(event) => update({ modelName: event.target.value })} placeholder="全部模型" style={{ ...inputStyle, width: '100%' }} />
        </label>
        <button type="submit" disabled={loading} style={{ minHeight: 34, padding: '0 16px', border: '1px solid #0969da', borderRadius: 5, background: '#0969da', color: '#fff', cursor: loading ? 'default' : 'pointer' }}>
          {loading ? '查询中…' : '查询'}
        </button>
        <button type="button" onClick={onReset} disabled={loading} style={{ minHeight: 34, padding: '0 12px', border: '1px solid #ccc', borderRadius: 5, background: '#fff', cursor: loading ? 'default' : 'pointer' }}>
          重置
        </button>
      </div>
    </form>
  )
}
