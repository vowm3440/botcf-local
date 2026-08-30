import { UsageLogItem } from '../api'

interface LogTableProps {
  items: UsageLogItem[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

function usd(value: number): string {
  if (!Number.isFinite(value)) return '--'
  return `$${value.toFixed(value >= 0.01 ? 4 : 6)}`
}

export default function LogTable({ items, total, page, pageSize, loading, onPageChange, onPageSizeChange }: LogTableProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const cellStyle = { padding: '9px 10px', borderBottom: '1px solid #ececec', textAlign: 'left' as const, whiteSpace: 'nowrap' as const }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: '#f4f6f8' }}>
            <tr>
              {['时间', '分组', '令牌', '模型', 'Prompt', 'Completion', 'Quota', '折算 USD', '耗时', '流式'].map((heading) => (
                <th key={heading} style={{ ...cellStyle, borderBottomColor: '#d8d8d8', color: '#444', fontWeight: 600 }}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td style={cellStyle}>{new Date(item.created_at * 1000).toLocaleString()}</td>
                <td style={cellStyle}>{item.group || '--'}</td>
                <td style={{ ...cellStyle, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.token_name}>{item.token_name || '--'}</td>
                <td style={{ ...cellStyle, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.model_name}>{item.model_name || '--'}</td>
                <td style={cellStyle}>{item.prompt_tokens.toLocaleString()}</td>
                <td style={cellStyle}>{item.completion_tokens.toLocaleString()}</td>
                <td style={cellStyle}>{item.quota.toLocaleString()}</td>
                <td style={cellStyle}>{usd(item.quotaUsd)}</td>
                <td style={cellStyle}>{item.use_time.toFixed(2)} 秒</td>
                <td style={cellStyle}>{item.is_stream ? '是' : '否'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && items.length === 0 && <div style={{ padding: 40, color: '#777', textAlign: 'center' }}>没有符合条件的使用日志</div>}
        {loading && <div style={{ padding: 40, color: '#666', textAlign: 'center' }}>正在加载日志…</div>}
      </div>
      <div style={{ minHeight: 48, padding: '8px 16px', borderTop: '1px solid #e1e1e1', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, background: '#fafafa', boxSizing: 'border-box' }}>
        <span style={{ color: '#666', fontSize: 12 }}>共 {total.toLocaleString()} 条</span>
        <label style={{ color: '#666', fontSize: 12 }}>
          每页
          <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))} disabled={loading} style={{ marginLeft: 5 }}>
            {[20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <button type="button" title="上一页" aria-label="上一页" disabled={loading || page <= 0} onClick={() => onPageChange(page - 1)} style={{ width: 32, height: 30 }}>←</button>
        <span style={{ minWidth: 76, textAlign: 'center', fontSize: 12 }}>{page + 1} / {pageCount}</span>
        <button type="button" title="下一页" aria-label="下一页" disabled={loading || page + 1 >= pageCount} onClick={() => onPageChange(page + 1)} style={{ width: 32, height: 30 }}>→</button>
      </div>
    </div>
  )
}
