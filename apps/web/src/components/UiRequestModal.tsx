import { useState } from 'react'
import { api, OmpUiRequest } from '../api'

interface UiRequestModalProps {
  request: OmpUiRequest
  onDone: () => void
}

/** Modal for OMP extension-UI dialogs: tool-execution confirmations, selections
 *  and text inputs. Answering posts an extension_ui_response frame. */
export default function UiRequestModal({ request, onDone }: UiRequestModalProps) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const respond = async (payload: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    setBusy(true)
    try {
      await api.ompUiResponse({ id: request.id, ...payload })
    } catch {
      /* OMP may have timed out the dialog already */
    } finally {
      setBusy(false)
      onDone()
    }
  }

  const optionLabel = (o: string | { label?: string; value?: string }): string =>
    typeof o === 'string' ? o : (o.label ?? o.value ?? '')
  const optionValue = (o: string | { label?: string; value?: string }): string =>
    typeof o === 'string' ? o : (o.value ?? o.label ?? '')

  const isConfirm = request.method === 'confirm'
  const isSelect = request.method === 'select' && Array.isArray(request.options)
  const isInput = request.method === 'input' || request.method === 'editor'

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: 8, padding: 24, minWidth: 380, maxWidth: 560, boxShadow: '0 8px 30px rgba(0,0,0,0.2)' }}>
        <h3 style={{ marginTop: 0 }}>{request.title ?? 'OMP 请求确认'}</h3>
        {request.message && <p style={{ whiteSpace: 'pre-wrap' }}>{request.message}</p>}

        {isSelect && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {request.options!.map((o, i) => (
              <button key={i} disabled={busy} onClick={() => respond({ value: optionValue(o) })} style={{ padding: 8, textAlign: 'left' }}>
                {optionLabel(o)}
              </button>
            ))}
          </div>
        )}

        {isInput && (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={request.placeholder}
            rows={request.method === 'editor' ? 8 : 2}
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12, padding: 8 }}
          />
        )}

        {!isConfirm && !isSelect && !isInput && (
          <pre style={{ background: '#f5f5f5', padding: 8, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(request, null, 2)}</pre>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button disabled={busy} onClick={() => respond({ cancelled: true })}>取消</button>
          {isConfirm && (
            <>
              <button disabled={busy} onClick={() => respond({ confirmed: false })}>拒绝</button>
              <button disabled={busy} onClick={() => respond({ confirmed: true })} style={{ background: '#1668dc', color: '#fff' }}>允许</button>
            </>
          )}
          {isInput && (
            <button disabled={busy} onClick={() => respond({ value: text })} style={{ background: '#1668dc', color: '#fff' }}>提交</button>
          )}
        </div>
      </div>
    </div>
  )
}
