import DiffView from './DiffView'
import type { ToolCall } from '../chat/messages'

/** One tool call in the transcript: collapsed once it finishes, expanded while it
 *  runs so the user can watch what the assistant is doing rather than wait for a
 *  silent pause to end. */

const STATUS_TEXT: Record<ToolCall['status'], string> = {
  running: '执行中',
  done: '完成',
  error: '失败'
}

export default function ToolCard({ tool }: { tool: ToolCall }) {
  const failed = tool.status === 'error'
  return (
    <details
      id={`tool-${tool.id}`}
      open={tool.status === 'running'}
      style={{ marginTop: 8, border: `1px solid ${failed ? '#efb4b4' : '#e1e4e8'}`, borderRadius: 6, background: '#fafbfc' }}
    >
      <summary style={{ cursor: 'pointer', padding: '6px 8px', fontWeight: 600, fontSize: 12 }}>
        {tool.name}{' '}
        <span style={{ color: failed ? '#cf222e' : '#777', fontWeight: 400 }}>· {STATUS_TEXT[tool.status]}</span>
        {tool.intent && <span style={{ color: '#777', fontWeight: 400 }}> · {tool.intent}</span>}
      </summary>
      <div style={{ padding: '0 8px 8px' }}>
        {tool.args !== undefined && (
          <>
            <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>参数</div>
            <pre style={{ margin: '4px 0', padding: 8, overflowX: 'auto', background: '#f0f1f3', fontSize: 11 }}>
              {JSON.stringify(tool.args, null, 2)}
            </pre>
          </>
        )}
        {tool.output && (
          <>
            <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>输出</div>
            <pre
              style={{
                margin: '4px 0',
                padding: 8,
                maxHeight: 240,
                overflow: 'auto',
                background: '#f0f1f3',
                fontSize: 11,
                whiteSpace: 'pre-wrap'
              }}
            >
              {tool.output}
            </pre>
          </>
        )}
        {tool.diff && (
          <>
            <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>文件差异</div>
            <div style={{ margin: '4px 0' }}>
              <DiffView diff={tool.diff} />
            </div>
          </>
        )}
      </div>
    </details>
  )
}
