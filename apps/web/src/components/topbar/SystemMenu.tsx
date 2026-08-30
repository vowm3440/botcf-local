import { useState } from 'react'
import { api, type AccessMode, type AppStateInfo } from '../../api'
import { MONO } from '../ui'
import { CAPTION, CHROME, Dot, GhostButton, Picker, type Tone } from './chrome'
import { HealthDetail } from './Health'
import { InlineForm, MenuActions, MenuRow, MenuSection, Popover } from './Menu'
import type { ModelHealth } from './useModelHealth'
import type { TopBarData } from './useTopBarData'

/** The settings popover, and the one glyph in the bar that opens it.
 *
 *  Five groups, in the order you would go looking for them: the runtime that
 *  executes tools, how much it may do without asking, the directory it executes
 *  them in, what the account has spent, and how the routed model is behaving.
 *  Sign-out sits alone at the bottom, away from anything you might mean to click.
 *
 *  The trigger carries a status light so hiding all of this costs nothing: amber
 *  when the runtime is idle or an update is waiting, red when something failed. */

export interface SystemMenuProps {
  state: AppStateInfo
  data: TopBarData
  health: ModelHealth
  onLoggedOut: () => void
  /** Re-read /api/state after a setting changes. */
  onChanged: () => void
}

const CHANNELS = [
  { value: 'fast', label: '快速通道' },
  { value: 'stable', label: '稳定通道' },
  { value: 'experimental', label: '实验通道' }
]

const ACCESS_MODES = [
  { value: 'ask', label: '确认模式' },
  { value: 'full', label: '完全访问' }
]

interface RuntimeStatus {
  tone: Tone
  text: string
}

function runtimeStatus(state: AppStateInfo, data: TopBarData): RuntimeStatus {
  const { omp } = data
  if (state.omp.running) return { tone: 'ok', text: '运行中' }
  if (omp.protocolError) return { tone: 'warn', text: 'RPC 不兼容 · 已降级直连' }
  if (state.omp.available) return { tone: 'warn', text: '已安装未运行' }
  if (omp.repo) return { tone: 'info', text: `等待下载 ${omp.upstream ?? '…'}` }
  return { tone: 'info', text: '未安装 · 直连模式' }
}

/** What the closed trigger has to be able to say without any words. */
function attentionTone(state: AppStateInfo, data: TopBarData): Tone | null {
  if (data.error || data.omp.lastError) return 'danger'
  if (data.omp.protocolError || (state.omp.available && !state.omp.running)) return 'warn'
  if (data.omp.updateAvailable || data.syncError) return 'warn'
  return null
}

function timeLabel(at: number | null): string {
  return at ? new Date(at).toLocaleTimeString() : '—'
}

export default function SystemMenu({ state, data, health, onLoggedOut, onChanged }: SystemMenuProps) {
  const [repoInput, setRepoInput] = useState<string | null>(null)
  const [workdirInput, setWorkdirInput] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)

  const status = runtimeStatus(state, data)
  const attention = attentionTone(state, data)
  const { omp } = data
  const thirdParty = state.mode === 'third-party'
  const accessMode = state.omp.accessMode

  const changeAccessMode = async (mode: AccessMode): Promise<void> => {
    setAccessError(null)
    try {
      await api.setAccessMode(mode)
      onChanged()
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : '切换失败')
    }
  }

  const submitRepo = async () => {
    if (repoInput === null) return
    setPending(true)
    if (await data.setRepo(repoInput.trim())) setRepoInput(null)
    setPending(false)
  }

  const submitWorkdir = async () => {
    if (workdirInput === null) return
    setPending(true)
    if (await data.setWorkdir(workdirInput.trim())) setWorkdirInput(null)
    setPending(false)
  }

  return (
    <Popover
      ariaLabel="系统设置"
      width={340}
      renderTrigger={({ open, toggle }) => (
        <GhostButton
          onClick={toggle}
          active={open}
          ariaLabel="系统设置"
          ariaExpanded={open}
          ariaHasPopup="dialog"
          title="运行时、权限、工作目录、用量与账号"
        >
          <span aria-hidden style={{ fontSize: 14, lineHeight: '18px' }}>
            ⚙
          </span>
          {attention && <Dot tone={attention} />}
        </GhostButton>
      )}
    >
      {(close) => (
        <>
          <MenuSection
            first
            title="运行时"
            aside={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Dot tone={status.tone} />
                <span style={{ fontSize: 11, color: CHROME.inkSecondary }}>{status.text}</span>
              </span>
            }
          >
            <MenuRow label="版本" title={omp.repo ?? '尚未配置 OMP 仓库'}>
              {omp.version ?? '—'}
              {omp.updateAvailable && (
                <span style={{ color: CHROME.warn }}> → {omp.upstream}</span>
              )}
            </MenuRow>
            <MenuRow label="更新通道">
              <Picker
                ariaLabel="OMP 更新通道"
                value={omp.channel}
                options={CHANNELS}
                onChange={(value) => {
                  data.setChannel(value).catch(() => undefined)
                }}
                maxWidth={120}
              />
            </MenuRow>
            <MenuRow label="上次检查">{timeLabel(omp.checkedAt)}</MenuRow>
            {omp.activity && (
              <div style={{ fontSize: 11, color: CHROME.accent, paddingTop: 2 }}>{omp.activity.text}</div>
            )}
            {omp.lastError && (
              <div style={{ fontSize: 11, color: CHROME.danger, paddingTop: 2, wordBreak: 'break-word' }}>
                更新异常:{omp.lastError}
              </div>
            )}
            <MenuActions>
              {omp.repo && (
                <GhostButton onClick={() => data.checkUpdate()} disabled={data.checkingUpdate} tone="accent">
                  {data.checkingUpdate ? '检查中…' : '检查更新'}
                </GhostButton>
              )}
              {state.omp.available && !state.omp.running && (
                <GhostButton onClick={() => data.restartOmp()} tone="accent">
                  启动 / 重连
                </GhostButton>
              )}
              <GhostButton onClick={() => setRepoInput(omp.repo ?? '')}>
                {omp.repo ? '更改仓库' : '配置仓库'}
              </GhostButton>
            </MenuActions>
            {repoInput !== null && (
              <InlineForm
                value={repoInput}
                ariaLabel="OMP 的 GitHub 仓库"
                placeholder="owner/repo"
                pending={pending}
                onChange={setRepoInput}
                onSubmit={() => {
                  submitRepo().catch(() => undefined)
                }}
                onCancel={() => setRepoInput(null)}
              />
            )}
          </MenuSection>

          <MenuSection
            title="权限"
            aside={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Dot tone={accessMode === 'full' ? 'warn' : 'ok'} />
                <span style={{ fontSize: 11, color: CHROME.inkSecondary }}>
                  {accessMode === 'full' ? '完全访问' : '确认模式'}
                </span>
              </span>
            }
          >
            <MenuRow label="工具确认">
              <Picker
                ariaLabel="工具确认模式"
                value={accessMode}
                options={ACCESS_MODES}
                onChange={(value) => {
                  changeAccessMode(value === 'full' ? 'full' : 'ask').catch(() => undefined)
                }}
                maxWidth={120}
              />
            </MenuRow>
            {/* Said plainly, because the honest scope is narrower than the name
                suggests: OMP's RPC protocol has no permission switch, so the only
                thing this changes is whether the confirmation dialog appears. */}
            <div style={{ fontSize: 11, color: CHROME.inkTertiary, paddingTop: 4, lineHeight: 1.6 }}>
              {accessMode === 'full'
                ? '运行时的工具确认由本机自动允许,一轮回答不会中途停下等你点「允许」。已自动允许的动作会记在对话里。这不会扩大 AI 能碰的范围——文件仍限于工作区目录,其余边界不变。'
                : '运行时请求确认时会弹窗问你,回答前不会继续。需要长时间无人值守时改成「完全访问」。'}
            </div>
            {accessError && (
              <div style={{ fontSize: 11, color: CHROME.danger, paddingTop: 2, wordBreak: 'break-word' }}>
                {accessError}
              </div>
            )}
          </MenuSection>

          <MenuSection
            title="工作目录"
            aside={
              data.roots.length > 1 ? (
                <span
                  style={{ fontSize: 11, color: CHROME.inkSecondary }}
                  title={data.roots.map((root) => `${root.name} — ${root.path}`).join('\n')}
                >
                  工作区 {data.roots.length} 个目录
                </span>
              ) : undefined
            }
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: data.workdir ? CHROME.ink : CHROME.inkTertiary,
                wordBreak: 'break-all',
                lineHeight: 1.6
              }}
            >
              {data.workdir ?? '默认目录'}
            </div>
            <MenuActions>
              <GhostButton
                onClick={() => setWorkdirInput(data.workdir ?? '')}
                title="切换 AI 的工作目录(会加入工作区并重启 OMP)"
              >
                更改主目录
              </GhostButton>
            </MenuActions>
            {workdirInput !== null && (
              <InlineForm
                value={workdirInput}
                ariaLabel="项目目录完整路径"
                placeholder={'完整路径,如 D:\\code\\myapp'}
                pending={pending}
                onChange={setWorkdirInput}
                onSubmit={() => {
                  submitWorkdir().catch(() => undefined)
                }}
                onCancel={() => setWorkdirInput(null)}
              />
            )}
          </MenuSection>

          {!thirdParty && (
            <MenuSection title="用量">
              <MenuRow label="余额">{data.usage ? `$${data.usage.quotaUsd.toFixed(2)}` : '—'}</MenuRow>
              <MenuRow label="已用">{data.usage ? `$${data.usage.usedQuotaUsd.toFixed(2)}` : '—'}</MenuRow>
              <MenuRow label="上次请求" title={data.lastRequest?.model}>
                {data.lastRequest
                  ? `$${data.lastRequest.costUsd.toFixed(4)} · ${data.lastRequest.promptTokens}+${data.lastRequest.completionTokens} tok`
                  : '—'}
              </MenuRow>
              <MenuRow label="已刷新">{timeLabel(data.refreshedAt)}</MenuRow>
              {data.syncError && (
                <div style={{ fontSize: 11, color: CHROME.warn, paddingTop: 2, wordBreak: 'break-word' }}>
                  用量同步失败:{data.syncError}
                </div>
              )}
              <MenuActions>
                <GhostButton onClick={data.syncNow} tone="accent">
                  立即同步额度与分组
                </GhostButton>
              </MenuActions>
            </MenuSection>
          )}

          {state.route && (
            <MenuSection title="模型状态" aside={<span style={CAPTION}>{state.route.modelId}</span>}>
              <HealthDetail health={health} />
            </MenuSection>
          )}

          <MenuSection title="账号" aside={<span style={CAPTION}>{state.user?.displayName ?? state.user?.username}</span>}>
            <MenuActions>
              <GhostButton
                tone="danger"
                onClick={() => {
                  close()
                  // A failed sign-out still refreshes state, which then shows the
                  // session as intact rather than pretending it ended.
                  api.logout().then(onLoggedOut).catch(onLoggedOut)
                }}
              >
                退出登录
              </GhostButton>
            </MenuActions>
          </MenuSection>
        </>
      )}
    </Popover>
  )
}
