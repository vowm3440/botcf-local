import { IDE_PANELS, type IdePanelId } from '../panels/panelVisibility'
import type { PanelToggles as PanelTogglesApi } from '../panels/usePanelToggles'

/** Toggle strip for the workbench panels.
 *
 *  A compact row rather than a menu: with six panels the state itself is the
 *  information the user needs ("is the diagnostics panel open, and does it have
 *  errors?"), and a badge carries the count so a problem is visible without
 *  opening anything. */

export interface PanelTogglesProps {
  toggles: PanelTogglesApi
  /** Small counts rendered next to a label (pending reviews, error count …). */
  badges?: Partial<Record<IdePanelId, number>>
  /** Panels to render as urgent (non-zero errors). */
  alerts?: Partial<Record<IdePanelId, boolean>>
  disabled?: boolean
}

export default function PanelToggles({ toggles, badges, alerts, disabled }: PanelTogglesProps) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      {IDE_PANELS.map((panel) => {
        const active = toggles.isVisible(panel.id)
        const badge = badges?.[panel.id] ?? 0
        const alert = alerts?.[panel.id] === true
        return (
          <button
            key={panel.id}
            type="button"
            onClick={() => toggles.toggle(panel.id)}
            disabled={disabled}
            aria-pressed={active}
            title={panel.hint}
            style={{
              fontSize: 12,
              padding: '2px 8px',
              borderRadius: 4,
              cursor: disabled ? 'default' : 'pointer',
              border: `1px solid ${alert ? '#efb4b4' : active ? '#b8d1ee' : '#ddd'}`,
              background: alert ? '#fff5f5' : active ? '#eaf3ff' : '#fff',
              color: alert ? '#c00' : active ? '#075aa6' : '#555',
              fontWeight: active || alert ? 600 : 400
            }}
          >
            {panel.label}
            {badge > 0 && (
              <span
                style={{
                  marginLeft: 4,
                  padding: '0 4px',
                  borderRadius: 8,
                  fontSize: 10,
                  background: alert ? '#c00' : '#0969da',
                  color: '#fff'
                }}
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
