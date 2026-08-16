import { useCallback, useEffect, useState } from 'react'
import { api, AppStateInfo, GroupInfo, ModelInfo } from '../api'

interface TopBarProps {
  state: AppStateInfo
  onRouteChanged: () => void
}

export default function TopBar({ state, onRouteChanged }: TopBarProps) {
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [group, setGroup] = useState(state.route?.group ?? '')
  const [model, setModel] = useState(state.route?.modelId ?? '')
  const [thinking, setThinking] = useState(state.route?.thinkingLevel ?? '')
  const [usage, setUsage] = useState<{ quotaUsd: number; usedQuotaUsd: number } | null>(
    state.user ? { quotaUsd: state.user.quotaUsd, usedQuotaUsd: state.user.usedQuotaUsd } : null
  )
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ompVersion, setOmpVersion] = useState<string | null>(null)
  const [ompRepo, setOmpRepo] = useState<string | null>(null)
  const [ompUpstream, setOmpUpstream] = useState<string | null>(null)
  const [ompChannel, setOmpChannel] = useState<'fast' | 'stable' | 'experimental'>('fast')
  const [ompProtoError, setOmpProtoError] = useState<string | null>(null)
  const [repoEditing, setRepoEditing] = useState(false)
  const [repoInput, setRepoInput] = useState('')
  const [workdir, setWorkdir] = useState<string | null>(null)
  const [workdirEditing, setWorkdirEditing] = useState(false)
  const [workdirInput, setWorkdirInput] = useState('')

  const refreshOmp = useCallback(() => {
    api.ompStatus().then((r) => {
      setOmpVersion(r.update.currentVersion)
      setOmpRepo(r.update.repo)
      setOmpUpstream(r.update.latestUpstream)
      setOmpChannel(r.update.channel)
      setOmpProtoError(r.protocolError)
      setWorkdir(r.workdir)
    }).catch(() => setOmpVersion(null))
  }, [])

  const loadGroups = useCallback(async (refresh = false) => {
    try {
      const r = await api.groups(refresh)
      setGroups(r.groups.filter((g) => !g.hidden))
    } catch (e) {
      // Keep the last good list on transient failures; only surface the error.
      setError(`分组加载失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  const loadModels = useCallback(async (targetGroup: string) => {
    try {
      const r = await api.models(targetGroup)
      setModels(r.models)
      setError(null)
    } catch (e) {
      setModels([])
      setError(`模型加载失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  useEffect(() => {
    loadGroups()
    refreshOmp()
    const ompInterval = setInterval(refreshOmp, 15_000)
    // 与网站保持同步:每 5 分钟强制绕过服务端 pricing 缓存重新拉取分组。
    const groupsInterval = setInterval(() => loadGroups(true), 300_000)
    return () => {
      clearInterval(ompInterval)
      clearInterval(groupsInterval)
    }
  }, [loadGroups, refreshOmp])

  useEffect(() => {
    if (!group) return
    loadModels(group)
  }, [group, loadModels])

  // Reflect server-side route restoration (e.g. after app restart) into the pickers.
  useEffect(() => {
    if (state.route) {
      setGroup(state.route.group)
      setModel(state.route.modelId)
      setThinking(state.route.thinkingLevel ?? '')
    }
  }, [state.route])

  const [lastRequest, setLastRequest] = useState<{ model: string; costUsd: number; promptTokens: number; completionTokens: number } | null>(null)

  const refreshUsage = useCallback(async () => {
    try {
      const r = await api.usage()
      setUsage({ quotaUsd: r.account.quotaUsd, usedQuotaUsd: r.account.usedQuotaUsd })
      setRefreshedAt(r.refreshedAt)
      if (r.recentRequests.length > 0) {
        const last = r.recentRequests[0]
        setLastRequest({ model: last.model, costUsd: last.costUsd, promptTokens: last.promptTokens, completionTokens: last.completionTokens })
      }
      setSyncError(null)
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : '同步失败')
    }
  }, [])

  // Plan cadence: an extra refresh 2s and 15s after each completed turn, so the
  // billing panel converges with BotCF's ledger quickly.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const onTurnComplete = () => {
      timers.push(setTimeout(refreshUsage, 2_000))
      timers.push(setTimeout(refreshUsage, 15_000))
    }
    window.addEventListener('botcf:turn-complete', onTurnComplete)
    return () => {
      window.removeEventListener('botcf:turn-complete', onTurnComplete)
      timers.forEach(clearTimeout)
    }
  }, [refreshUsage])

  // Plan cadence: 30s while generating, 2min idle.
  useEffect(() => {
    refreshUsage()
    const interval = setInterval(refreshUsage, state.generationInFlight ? 30_000 : 120_000)
    return () => clearInterval(interval)
  }, [refreshUsage, state.generationInFlight])

  const applyRoute = async (nextGroup: string, nextModel: string, nextThinking: string) => {
    if (!nextGroup || !nextModel) return
    setBusy(true)
    setError(null)
    try {
      await api.setRoute({ group: nextGroup, model: nextModel, thinkingLevel: nextThinking || undefined })
      onRouteChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '切换失败')
    } finally {
      setBusy(false)
    }
  }

  const selectedModel = models.find((m) => m.id === model)

  return (
    <div style={{ borderBottom: '1px solid #ddd', padding: '10px 16px', background: '#fafafa', fontSize: 14 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>
          <strong>余额</strong> {usage ? `$${usage.quotaUsd.toFixed(2)}` : '—'} / 已用 {usage ? `$${usage.usedQuotaUsd.toFixed(2)}` : '—'}
          {refreshedAt && <small style={{ color: '#888' }}> ({new Date(refreshedAt).toLocaleTimeString()} 已刷新)</small>}
        </span>
        {lastRequest && (
          <span style={{ color: '#888' }} title={lastRequest.model}>
            上次请求 ${lastRequest.costUsd.toFixed(4)} ({lastRequest.promptTokens}+{lastRequest.completionTokens} tok)
          </span>
        )}

        <select value={group} onFocus={() => loadGroups()} onChange={(e) => { setGroup(e.target.value); setModel('') }} disabled={busy}>
          <option value="">选择分组…</option>
          {groups.map((g) => (
            <option key={g.name} value={g.name} disabled={!g.usable} title={g.reason ?? g.description}>
              {g.name}{g.description ? ` — ${g.description}` : ''}{!g.usable ? '(不可用)' : g.reason ? ' ⚠' : ''}
            </option>
          ))}
        </select>

        <select value={model} onChange={(e) => { setModel(e.target.value); applyRoute(group, e.target.value, thinking) }} disabled={busy || !group}>
          <option value="">选择模型…</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </select>

        {selectedModel && selectedModel.thinkingLevels.length === 0 ? (
          <span style={{ color: '#aaa' }}>该模型不支持思考等级</span>
        ) : (
          <select value={thinking} onChange={(e) => { setThinking(e.target.value); applyRoute(group, model, e.target.value) }} disabled={busy || !selectedModel}>
            <option value="">思考等级…</option>
            {(selectedModel?.thinkingLevels ?? []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}

        {state.route && (
          <span style={{ color: '#0a6' }}>
            上下文: {state.route.capabilityLabel}
          </span>
        )}
        <span style={{ color: '#888' }}>
          OMP: {state.omp.running
            ? `运行中 ${ompVersion ?? ''}`
            : ompProtoError
              ? `${ompVersion ?? ''} RPC 不兼容(已降级直连)`
              : state.omp.available
                ? '已安装未运行'
                : ompRepo
                  ? `等待下载 ${ompUpstream ?? '…'}`
                  : '未安装(直连模式)'}
          {!state.omp.running && state.omp.available && (
            <button
              style={{ marginLeft: 6 }}
              onClick={async () => {
                try {
                  const r = await api.ompRestart()
                  if (!r.success && r.error) setError(`OMP 启动失败: ${r.error}`)
                  refreshOmp()
                  onRouteChanged()
                } catch (e) {
                  setError(`OMP 启动失败: ${e instanceof Error ? e.message : String(e)}`)
                }
              }}
            >启动/重连</button>
          )}
          {!state.omp.available && !repoEditing && (
            <button style={{ marginLeft: 6 }} onClick={() => { setRepoInput(ompRepo ?? ''); setRepoEditing(true) }}>配置仓库</button>
          )}
        </span>
        <select
          aria-label="OMP 更新通道"
          value={ompChannel}
          onChange={async (event) => {
            const channel = event.target.value
            if (channel !== 'fast' && channel !== 'stable' && channel !== 'experimental') return
            try {
              await api.setOmpChannel(channel)
              setOmpChannel(channel)
            } catch (e) {
              setError(e instanceof Error ? e.message : '通道切换失败')
            }
          }}
        >
          <option value="fast">快速通道</option>
          <option value="stable">稳定通道</option>
          <option value="experimental">实验通道</option>
        </select>
        {repoEditing && (
          <span>
            <input
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder="owner/repo (OMP 的 GitHub 仓库)"
              style={{ width: 220 }}
            />
            <button
              style={{ marginLeft: 4 }}
              onClick={async () => {
                try {
                  await api.setOmpRepo(repoInput.trim())
                  setRepoEditing(false)
                  refreshOmp()
                  onRouteChanged()
                } catch (e) {
                  setError(e instanceof Error ? e.message : '配置失败')
                }
              }}
            >保存</button>
            <button style={{ marginLeft: 4 }} onClick={() => setRepoEditing(false)}>取消</button>
          </span>
        )}

        {state.omp.available && !workdirEditing && (
          <span style={{ color: '#888' }}>
            目录: {workdir ? workdir.split(/[\\/]/).slice(-2).join('/') : '默认'}
            <button style={{ marginLeft: 4 }} title={workdir ?? undefined} onClick={() => { setWorkdirInput(workdir ?? ''); setWorkdirEditing(true) }}>更改</button>
          </span>
        )}
        {workdirEditing && (
          <span>
            <input
              value={workdirInput}
              onChange={(e) => setWorkdirInput(e.target.value)}
              placeholder="项目目录完整路径,如 D:\\code\\myapp"
              style={{ width: 260 }}
            />
            <button
              style={{ marginLeft: 4 }}
              onClick={async () => {
                try {
                  await api.setWorkdir(workdirInput.trim())
                  setWorkdirEditing(false)
                  refreshOmp()
                  onRouteChanged()
                } catch (e) {
                  setError(e instanceof Error ? e.message : '目录设置失败')
                }
              }}
            >保存</button>
            <button style={{ marginLeft: 4 }} onClick={() => setWorkdirEditing(false)}>取消</button>
          </span>
        )}
        <button
          onClick={() => {
            refreshUsage()
            loadGroups(true)
            if (group) loadModels(group)
          }}
          style={{ marginLeft: 'auto' }}
        >立即同步</button>
        <button onClick={() => api.logout().then(onRouteChanged)}>退出</button>
      </div>
      {error && <div style={{ color: '#c00', marginTop: 6 }}>{error}</div>}
      {syncError && <div style={{ color: '#c60', marginTop: 6 }}>用量同步失败: {syncError}</div>}
    </div>
  )
}
