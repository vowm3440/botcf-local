import { useEffect, useMemo, useState } from 'react'
import { api, GroupInfo, LogQuery, logsExportUrl, LogsResponse } from '../api'
import LogFilters, { LogFilterValues, recentRange } from '../components/LogFilters'
import LogTable from '../components/LogTable'

const initialFilters = (): LogFilterValues => ({
  ...recentRange(7),
  group: '',
  tokenName: '',
  modelName: ''
})

function timestamp(value: string): number | undefined {
  if (!value) return undefined
  const milliseconds = new Date(value).getTime()
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined
}

function queryFrom(filters: LogFilterValues, page: number, pageSize: number): LogQuery {
  return {
    page,
    pageSize,
    tokenName: filters.tokenName.trim() || undefined,
    modelName: filters.modelName.trim() || undefined,
    group: filters.group || undefined,
    startTs: timestamp(filters.start),
    endTs: timestamp(filters.end)
  }
}

function logsError(error: unknown): string {
  const message = error instanceof Error ? error.message : '日志加载失败'
  return /登录|session|401|403|权限/i.test(message) ? 'BotCF 会话可能已过期，请退出后重新登录' : message
}

export default function UsageLogs({ available }: { available: boolean }) {
  const [filters, setFilters] = useState<LogFilterValues>(initialFilters)
  const [applied, setApplied] = useState<LogFilterValues>(initialFilters)
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [result, setResult] = useState<LogsResponse>({ success: true, items: [], total: 0, page: 0, pageSize: 20 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const query = useMemo(() => queryFrom(applied, page, pageSize), [applied, page, pageSize])

  useEffect(() => {
    if (!available) return
    api.groups().then((response) => setGroups(response.groups.filter((group) => !group.hidden))).catch(() => undefined)
  }, [available])

  useEffect(() => {
    if (!available) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api.logs(query)
      .then((response) => {
        if (!cancelled) setResult(response)
      })
      .catch((reason) => {
        if (!cancelled) setError(logsError(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [available, query, refreshKey])

  if (!available) {
    return <div style={{ padding: 24, color: '#666' }}>使用日志仅适用于 BotCF 账户。</div>
  }

  const apply = () => {
    setPage(0)
    setApplied({ ...filters })
    if (page === 0 && JSON.stringify(filters) === JSON.stringify(applied)) setRefreshKey((value) => value + 1)
  }

  const reset = () => {
    const next = initialFilters()
    setFilters(next)
    setApplied(next)
    setPage(0)
  }

  const download = (format: 'csv' | 'json') => {
    window.location.assign(logsExportUrl(queryFrom(applied, 0, pageSize), format))
  }

  return (
    <section style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div style={{ minHeight: 52, padding: '9px 16px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #ddd' }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>使用日志</h1>
        <span style={{ color: '#777', fontSize: 12 }}>{result.total.toLocaleString()} 条</span>
        <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading} style={{ marginLeft: 'auto', minHeight: 32 }}>刷新</button>
        <button type="button" onClick={() => download('csv')} disabled={loading} style={{ minHeight: 32 }}>下载 CSV</button>
        <button type="button" onClick={() => download('json')} disabled={loading} style={{ minHeight: 32 }}>下载 JSON</button>
      </div>
      <LogFilters value={filters} groups={groups} loading={loading} onChange={setFilters} onApply={apply} onReset={reset} />
      {error && <div role="alert" style={{ padding: '9px 16px', color: '#a40000', background: '#fff2f0', borderBottom: '1px solid #f0c8c3' }}>{error}</div>}
      <LogTable
        items={result.items}
        total={result.total}
        page={page}
        pageSize={pageSize}
        loading={loading}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(0) }}
      />
    </section>
  )
}
