import type { AppStateInfo } from '../api'
import BalanceMeter from './topbar/BalanceMeter'
import { CHROME, CLUSTER, Divider, GhostButton, Pill } from './topbar/chrome'
import { HealthPulse } from './topbar/Health'
import RouteBreadcrumb from './topbar/RouteBreadcrumb'
import SystemMenu from './topbar/SystemMenu'
import { useModelHealth } from './topbar/useModelHealth'
import { useTopBarData } from './topbar/useTopBarData'

/** The application chrome: one 44px row that never wraps.
 *
 *  Three zones, and the split is by *kind* of information rather than by feature.
 *  Left is the route — the only thing here you change on purpose. Middle is
 *  telemetry you glance at: the model's health pulse, and the updater's progress
 *  while it has any. Right is the account: balance against quota, and the ⚙ that
 *  holds every setting the bar used to spell out inline.
 *
 *  What moved out matters as much as what stayed. The old bar carried twenty
 *  controls — three pickers, an OMP status sentence with three buttons, a channel
 *  select, a directory with an edit button, sync, sign-out — and reflowed into
 *  three rows on a narrow window, taking 140px from the workbench. Configuration
 *  is now one glyph, status became typography, and the height is fixed: nothing
 *  the runtime reports can push the editor down a line.
 *
 *  Errors are the exception that earns the extra row, and only until dismissed. */

export interface TopBarProps {
  state: AppStateInfo
  onRouteChanged: () => void
}

export default function TopBar({ state, onRouteChanged }: TopBarProps) {
  const data = useTopBarData(state, onRouteChanged)
  const health = useModelHealth(state.route?.group ?? '', state.route?.modelId ?? '')
  const third = state.mode === 'third-party' ? state.thirdParty : null
  const hasHealth = Boolean(health.site || health.local)

  return (
    <>
      <header
        aria-label="顶栏"
        style={{
          flex: 'none',
          height: CHROME.height,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 8px 0 12px',
          background: CHROME.surface,
          borderBottom: `1px solid ${CHROME.hairline}`,
          // Its own stacking context, above the workbench: the settings popover
          // hangs out of the bar, so the bar must not clip or be painted under.
          position: 'relative',
          zIndex: 20,
          whiteSpace: 'nowrap'
        }}
      >
        <RouteBreadcrumb data={data} route={state.route} third={third} />

        {(hasHealth || data.omp.activity) && (
          // Telemetry gives way first: on a narrow window the pulse and the
          // updater pill are clipped before the balance or the ⚙ are pushed off.
          <div style={{ ...CLUSTER, gap: 10, overflow: 'hidden' }}>
            {hasHealth && (
              <>
                <Divider />
                <HealthPulse health={health} />
              </>
            )}
            {data.omp.activity && (
              <Pill tone={data.omp.activity.tone} title="OMP 运行时更新进度">
                {data.omp.activity.text}
              </Pill>
            )}
          </div>
        )}

        <span style={{ flex: 1, minWidth: 8 }} />

        {!third && (
          <>
            <BalanceMeter usage={data.usage} refreshedAt={data.refreshedAt} lastRequest={data.lastRequest} />
            <Divider />
          </>
        )}

        <SystemMenu
          state={state}
          data={data}
          health={health}
          onLoggedOut={onRouteChanged}
          onChanged={onRouteChanged}
        />
      </header>

      {data.error && (
        <div
          role="alert"
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '3px 8px 3px 12px',
            background: CHROME.dangerSoft,
            borderBottom: `1px solid ${CHROME.hairline}`,
            fontSize: 11,
            color: '#82071e'
          }}
        >
          <span
            title={data.error}
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {data.error}
          </span>
          <GhostButton onClick={data.dismissError} tone="danger" ariaLabel="关闭提示" title="关闭提示">
            ✕
          </GhostButton>
        </div>
      )}
    </>
  )
}
