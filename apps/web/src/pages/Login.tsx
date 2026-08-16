import { useState } from 'react'
import { api } from '../api'

interface LoginProps {
  onLoggedIn: () => void
}

export default function Login({ onLoggedIn }: LoginProps) {
  const [mode, setMode] = useState<'password' | 'token' | 'third'>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'third') {
        await api.thirdPartyLogin({ baseUrl, apiKey, models: modelsText })
        setApiKey('')
      } else {
        await api.login(mode === 'password' ? { mode, username, password } : { mode, token })
        setPassword('')
        setToken('')
      }
      onLoggedIn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = mode === 'password'
    ? Boolean(username && password)
    : mode === 'token'
      ? Boolean(token)
      : Boolean(baseUrl.trim() && apiKey.trim() && modelsText.trim())

  const inputStyle = { display: 'block', width: '100%', padding: 10, margin: '8px 0', boxSizing: 'border-box' as const }

  return (
    <div style={{ padding: 20, maxWidth: 420, margin: '80px auto', fontFamily: 'sans-serif' }}>
      <h1>BotCF 本地控制台</h1>
      <div style={{ margin: '12px 0' }}>
        <label style={{ marginRight: 16 }}>
          <input type="radio" checked={mode === 'password'} onChange={() => setMode('password')} /> 账号密码
        </label>
        <label style={{ marginRight: 16 }}>
          <input type="radio" checked={mode === 'token'} onChange={() => setMode('token')} /> 管理 Token
        </label>
        <label>
          <input type="radio" checked={mode === 'third'} onChange={() => setMode('third')} /> 第三方
        </label>
      </div>

      {mode === 'password' && (
        <>
          <input style={inputStyle} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="BotCF 用户名" autoComplete="username" />
          <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码(仅用于本次登录,不落盘)" autoComplete="current-password" />
        </>
      )}
      {mode === 'token' && (
        <input style={inputStyle} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="在 BotCF 控制台创建的系统访问令牌" />
      )}
      {mode === 'third' && (
        <>
          <input style={inputStyle} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL,如 https://api.example.com(不带 /v1)" />
          <input style={inputStyle} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key" />
          <textarea
            style={{ ...inputStyle, height: 80, resize: 'vertical' as const, fontFamily: 'inherit' }}
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            placeholder={'模型 ID,逗号或换行分隔,如:\ngpt-4o\nclaude-4-sonnet'}
          />
        </>
      )}

      <button onClick={submit} disabled={busy || !canSubmit} style={{ padding: '10px 24px' }}>
        {busy ? (mode === 'third' ? '保存中…' : '登录中…') : mode === 'third' ? '保存并进入' : '登录'}
      </button>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <p style={{ fontSize: 12, color: '#666' }}>
        {mode === 'third'
          ? 'claude 开头的模型走 Anthropic Messages 接口,其余走 OpenAI 兼容 Chat Completions;API Key 用 AES-256-GCM 加密存储在本地,只由本机凭据代理注入请求。'
          : '密码只用于向 botcf.com 发起一次登录请求,绝不写入数据库或日志;会话与 API Key 均加密存储在本地。'}
      </p>
    </div>
  )
}
