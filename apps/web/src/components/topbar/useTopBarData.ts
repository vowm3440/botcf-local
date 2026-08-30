import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  type AppStateInfo,
  type GroupInfo,
  type ModelInfo,
  type OmpUpdateEvent,
  type WorkspaceRootInfo
} from '../../api'
import { notifyWorkspaceChanged, onWorkspaceChanged } from '../../workspace/events'
import type { Tone } from './chrome'

/** Everything the top bar knows, with none of the layout.
 *
 *  The bar reads five independent feeds — groups, models, account usage, the OMP
 *  runtime and the workspace — each on its own cadence, plus the updater's SSE
 *  stream. Keeping them here leaves the components to be about arrangement, and
 *  keeps the polling in one place where the cadences can be compared. */

export type OmpChannel = 'fast' | 'stable' | 'experimental'

export interface OmpActivity {
  text: string
  tone: Tone
}

export interface OmpData {
  version: string | null
  repo: string | null
  upstream: string | null
  channel: OmpChannel
  protocolError: string | null
  lastError: string | null
  checkedAt: number | null
  /** Live updater progress; null once the runtime settled. */
  activity: OmpActivity | null
  updateAvailable: boolean
}

export interface UsageData {
  quotaUsd: number
  usedQuotaUsd: number
}

export interface LastRequestData {
  model: string
  costUsd: number
  promptTokens: number
  completionTokens: number
}

export interface TopBarData {
  groups: GroupInfo[]
  models: ModelInfo[]
  group: string
  model: string
  thinking: string
  selectedModel: ModelInfo | undefined
  usage: UsageData | null
  refreshedAt: number | null
  lastRequest: LastRequestData | null
  syncError: string | null
  omp: OmpData
  workdir: string | null
  roots: WorkspaceRootInfo[]
  busy: boolean
  checkingUpdate: boolean
  error: string | null
  dismissError: () => void
  loadGroups: (refresh?: boolean) => void
  selectGroup: (name: string) => void
  selectModel: (id: string) => void
  selectThinking: (level: string) => void
  setChannel: (channel: string) => Promise<void>
  checkUpdate: () => Promise<void>
  restartOmp: () => Promise<void>
  setRepo: (repo: string) => Promise<boolean>
  setWorkdir: (path: string) => Promise<boolean>
  syncNow: () => void
}

const THIRD_PARTY_GROUP = '第三方'

/** Human-readable label for a live updater phase; null hides the activity text. */
function updateActivity(ev: OmpUpdateEvent): OmpActivity | null {
  const v = ev.version ?? ''
  switch (ev.phase) {
    case 'found':
      return v ? { text: `发现新版 ${v}`, tone: 'info' } : null
    case 'waiting-delay':
      return { text: `${v} 等待通道延迟窗口`, tone: 'info' }
    case 'waiting-idle':
      return { text: `${v} 等待会话空闲`, tone: 'info' }
    case 'downloading':
      return { text: `正在下载 ${v}`, tone: 'info' }
    case 'verifying':
      return { text: `正在校验 ${v}`, tone: 'info' }
    case 'switched':
      return { text: `已更新至 ${v}`, tone: 'ok' }
    case 'rolled-back':
      // A manual rollback is not a health failure; only the automatic path has
      // already recorded why it gave up on the new version.
      return ev.state.lastError
        ? { text: `健康检查失败,已回滚至 ${v}`, tone: 'warn' }
        : { text: `已回滚至 ${v}`, tone: 'warn' }
    case 'error':
      return { text: `更新失败: ${ev.error ?? '未知错误'}`, tone: 'danger' }
    default:
      return null
  }
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

export function useTopBarData(state: AppStateInfo, onRouteChanged: () => void): TopBarData {
  const third = state.mode === 'third-party' ? state.thirdParty : null

  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [group, setGroup] = useState(state.route?.group ?? '')
  const [model, setModel] = useState(state.route?.modelId ?? '')
  const [thinking, setThinking] = useState(state.route?.thinkingLevel ?? '')
  const [usage, setUsage] = useState<UsageData | null>(
    state.user ? { quotaUsd: state.user.quotaUsd, usedQuotaUsd: state.user.usedQuotaUsd } : null
  )
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const [lastRequest, setLastRequest] = useState<LastRequestData | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [upstream, setUpstream] = useState<string | null>(null)
  const [channel, setChannelState] = useState<OmpChannel>('fast')
  const [protocolError, setProtocolError] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [activity, setActivity] = useState<OmpActivity | null>(null)
  const [workdir, setWorkdirState] = useState<string | null>(null)
  const [roots, setRoots] = useState<WorkspaceRootInfo[]>([])
  const hasLoadedGroups = useRef(false)

  // Third-party mode has exactly one pseudo group — keep it selected.
  useEffect(() => {
    if (third) setGroup(THIRD_PARTY_GROUP)
  }, [third])

  const refreshOmp = useCallback(() => {
    api
      .ompStatus()
      .then((r) => {
        setVersion(r.update.currentVersion)
        setRepo(r.update.repo)
        setUpstream(r.update.latestUpstream)
        setChannelState(r.update.channel)
        setProtocolError(r.protocolError)
        setLastError(r.update.lastError)
        setCheckedAt(r.update.lastCheckedAt)
        setWorkdirState(r.workdir)
        setRoots(r.workspace?.roots ?? [])
        // SSE 断线兜底:轮询发现版本已收敛时清掉可能残留的过程态文案。
        if (r.update.currentVersion && r.update.currentVersion === r.update.latestUpstream) {
          setActivity(null)
        }
      })
      .catch(() => setVersion(null))
  }, [])

  // 实时同步:SSE 推送的更新器事件立即反映到状态区,不等 15s 轮询。
  useEffect(() => {
    const onUpdate = (ev: Event) => {
      const detail = (ev as CustomEvent<OmpUpdateEvent>).detail
      if (!detail?.state) return
      setVersion(detail.state.currentVersion)
      setUpstream(detail.state.latestUpstream)
      setChannelState(detail.state.channel)
      setLastError(detail.state.lastError)
      setCheckedAt(detail.state.lastCheckedAt)
      setActivity(updateActivity(detail))
    }
    window.addEventListener('botcf:omp-update', onUpdate)
    return () => window.removeEventListener('botcf:omp-update', onUpdate)
  }, [])

  // 文件面板里增删目录、切换主目录后,顶栏的目录状态立即跟上。
  useEffect(() => onWorkspaceChanged(refreshOmp), [refreshOmp])

  const loadGroups = useCallback(async (refresh = false) => {
    try {
      const r = await api.groups(refresh)
      setGroups(r.groups.filter((g) => !g.hidden))
      hasLoadedGroups.current = true
      setError(null)
    } catch (e) {
      // Keep a usable snapshot during transient BotCF/local-network failures.
      if (!hasLoadedGroups.current) setError(`分组加载失败: ${message(e, String(e))}`)
    }
  }, [])

  const loadModels = useCallback(async (targetGroup: string) => {
    try {
      const r = await api.models(targetGroup)
      setModels(r.models)
      setError(null)
    } catch (e) {
      setModels([])
      setError(`模型加载失败: ${message(e, String(e))}`)
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

  const refreshUsage = useCallback(async () => {
    if (state.mode === 'third-party') return
    try {
      const r = await api.usage()
      setUsage({ quotaUsd: r.account.quotaUsd, usedQuotaUsd: r.account.usedQuotaUsd })
      setRefreshedAt(r.refreshedAt)
      if (r.recentRequests.length > 0) {
        const last = r.recentRequests[0]
        setLastRequest({
          model: last.model,
          costUsd: last.costUsd,
          promptTokens: last.promptTokens,
          completionTokens: last.completionTokens
        })
      }
      setSyncError(null)
    } catch (e) {
      setSyncError(message(e, '同步失败'))
    }
  }, [state.mode])

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

  const applyRoute = useCallback(
    async (nextGroup: string, nextModel: string, nextThinking: string) => {
      if (!nextGroup || !nextModel) return
      setBusy(true)
      setError(null)
      try {
        await api.setRoute({ group: nextGroup, model: nextModel, thinkingLevel: nextThinking || undefined })
        onRouteChanged()
      } catch (e) {
        setError(message(e, '切换失败'))
      } finally {
        setBusy(false)
      }
    },
    [onRouteChanged]
  )

  const selectGroup = useCallback((name: string) => {
    setGroup(name)
    setModel('')
  }, [])

  const selectModel = useCallback(
    (id: string) => {
      setModel(id)
      applyRoute(group, id, thinking)
    },
    [applyRoute, group, thinking]
  )

  const selectThinking = useCallback(
    (level: string) => {
      setThinking(level)
      applyRoute(group, model, level)
    },
    [applyRoute, group, model]
  )

  const setChannel = useCallback(async (next: string) => {
    // The picker can only offer these three, but the value arrives as a string.
    if (next !== 'fast' && next !== 'stable' && next !== 'experimental') return
    try {
      await api.setOmpChannel(next)
      setChannelState(next)
    } catch (e) {
      setError(message(e, '通道切换失败'))
    }
  }, [])

  const checkUpdate = useCallback(async () => {
    setCheckingUpdate(true)
    try {
      const r = await api.ompCheckUpdate()
      setVersion(r.update.currentVersion)
      setUpstream(r.update.latestUpstream)
      setLastError(r.update.lastError)
      setCheckedAt(r.update.lastCheckedAt)
    } catch (e) {
      setError(`检查更新失败: ${message(e, String(e))}`)
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  const restartOmp = useCallback(async () => {
    try {
      const r = await api.ompRestart()
      if (!r.success && r.error) setError(`OMP 启动失败: ${r.error}`)
      refreshOmp()
      onRouteChanged()
    } catch (e) {
      setError(`OMP 启动失败: ${message(e, String(e))}`)
    }
  }, [onRouteChanged, refreshOmp])

  const submitRepo = useCallback(
    async (nextRepo: string) => {
      try {
        await api.setOmpRepo(nextRepo)
        refreshOmp()
        return true
      } catch (e) {
        setError(message(e, '配置失败'))
        return false
      }
    },
    [refreshOmp]
  )

  const submitWorkdir = useCallback(
    async (path: string) => {
      try {
        const result = await api.setWorkdir(path)
        setWorkdirState(result.workdir)
        setRoots(result.roots)
        // 文件面板/预览面板据此重新读取工作区。
        notifyWorkspaceChanged()
        refreshOmp()
        onRouteChanged()
        return true
      } catch (e) {
        setError(message(e, '目录设置失败'))
        return false
      }
    },
    [onRouteChanged, refreshOmp]
  )

  const syncNow = useCallback(() => {
    refreshUsage()
    loadGroups(true)
    if (group) loadModels(group)
  }, [group, loadGroups, loadModels, refreshUsage])

  return {
    groups,
    models,
    group,
    model,
    thinking,
    selectedModel: models.find((m) => m.id === model),
    usage,
    refreshedAt,
    lastRequest,
    syncError,
    omp: {
      version,
      repo,
      upstream,
      channel,
      protocolError,
      lastError,
      checkedAt,
      activity,
      updateAvailable: Boolean(upstream && version && upstream !== version)
    },
    workdir,
    roots,
    busy,
    checkingUpdate,
    error,
    dismissError: () => setError(null),
    loadGroups: (refresh = false) => {
      loadGroups(refresh)
    },
    selectGroup,
    selectModel,
    selectThinking,
    setChannel,
    checkUpdate,
    restartOmp,
    setRepo: submitRepo,
    setWorkdir: submitWorkdir,
    syncNow
  }
}
