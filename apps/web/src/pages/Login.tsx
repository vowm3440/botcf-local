import { useState } from 'react'
import { api } from '../api'

interface LoginProps {
  onLoggedIn: () => void
}

export default function Login({ onLoggedIn }: LoginProps) {
  const [mode, setMode] = useState<'password' | 'token'>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.login(mode === 'password' ? { mode, username, password } : { mode, token })
      setPassword('')
      setToken('')
      onLoggedIn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  const inputStyle = { display: 'block', width: '100%', padding: 10, margin: '8px 0', boxSizing: 'border-box' as const }

  return (
    <div style={{ padding: 20, maxWidth: 420, margin: '80px auto', fontFamily: 'sans-serif' }}>
      <h1>BotCF 本地控制台</h1>
      <div style={{ margin: '12px 0' }}>
        <label style={{ marginRight: 16 }}>
          <input type="radio" checked={mode === 'password'} onChange={() => setMode('password')} /> 账号密码
        </label>
        <label>
          <input type="radio" checked={mode === 'token'} onChange={() => setMode('token')} /> 管理 Token
        </label>
      </div>

      {mode === 'password' ? (
        <>
          <input style={inputStyle} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="BotCF 用户名" autoComplete="username" />
          <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码(仅用于本次登录,不落盘)" autoComplete="current-password" />
        </>
      ) : (
        <input style={inputStyle} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="在 BotCF 控制台创建的系统访问令牌" />
      )}

      <button onClick={submit} disabled={busy || (mode === 'password' ? !username || !password : !token)} style={{ padding: '10px 24px' }}>
        {busy ? '登录中…' : '登录'}
      </button>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <p style={{ fontSize: 12, color: '#666' }}>
        密码只用于向 botcf.com 发起一次登录请求,绝不写入数据库或日志;会话与 API Key 均加密存储在本地。
      </p>
    </div>
  )
}
