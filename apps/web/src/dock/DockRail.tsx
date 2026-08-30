import type { ReactNode } from 'react'
import { color, metric, text } from '../design/tokens'
import Badge from './Badge'
import Icon, { type IconName } from './icons'
import { locatePart } from './dockModel'
import { PARTS, RAIL_SECTIONS, RAIL_TRAILING, partMeta, type PartId } from './parts'
import type { DockApi } from './useDock'

/** The rail: one entry per part, and the guarantee that nothing can be lost.
 *
 *  In a layout where every pane can be closed, dragged and stacked, the rail is the
 *  answer to "where did it go" — every part in the catalogue has a permanent home
 *  here whether it is open or not. That is what makes the freedom safe.
 *
 *  Three states, because "open" and "in front" are different things: the accent bar
 *  means this part is the one you are looking at, plain ink means it is open behind
 *  another tab, grey means it is closed. Clicking the front one puts it away, which
 *  is the toggle every activity bar has taught.
 *
 *  Icon plus a two-character caption. Bare icons work in an editor whose icons the
 *  user has already learned; here the caption costs 11px of height and removes the
 *  guessing entirely. */

export interface RailExtra {
  id: string
  label: string
  title: string
  icon: IconName
  active: boolean
  onClick: () => void
}

export interface DockRailProps {
  dock: DockApi
  badges: Partial<Record<PartId, number>>
  alerts: Partial<Record<PartId, boolean>>
  /** Entries that are not dock parts — the usage log takes over the whole frame. */
  extras?: readonly RailExtra[]
}

interface ItemProps {
  icon: IconName
  label: string
  title: string
  /** In front in its group: the one thing on screen. */
  front: boolean
  /** Open, but behind another tab of its group. */
  open?: boolean
  onClick: () => void
  badge?: ReactNode
}

function RailItem({ icon, label, title, front, open = false, onClick, badge }: ItemProps) {
  return (
    <button
      type="button"
      className="dock-rail-item"
      aria-pressed={front}
      data-open={open ? 'true' : 'false'}
      title={title}
      onClick={onClick}
    >
      <span style={{ position: 'relative', display: 'flex' }}>
        <Icon name={icon} size={18} />
        {badge && <span style={{ position: 'absolute', top: -6, left: 10 }}>{badge}</span>}
      </span>
      <span style={{ ...text.micro, fontSize: 10, fontWeight: front ? 600 : 400 }}>{label}</span>
    </button>
  )
}

function Divider() {
  return <div aria-hidden style={{ height: 1, margin: '5px 10px', background: color.line }} />
}

export default function DockRail({ dock, badges, alerts, extras = [] }: DockRailProps) {
  const { root, zoomed } = dock.arrangement

  const renderPartItem = (id: PartId): ReactNode => {
    const meta = partMeta(id)
    const found = root ? locatePart(root, id) : null
    const front = found !== null && found.group.active === id && (!zoomed || zoomed === found.group.id)
    const count = badges[id] ?? 0
    return (
      <RailItem
        key={id}
        icon={meta.icon}
        label={meta.label}
        title={`${meta.title} — ${meta.hint}`}
        front={front}
        open={found !== null}
        onClick={() => dock.togglePart(id)}
        badge={count > 0 ? <Badge count={count} alert={alerts[id] === true} /> : undefined}
      />
    )
  }

  return (
    <nav
      aria-label="活动栏"
      style={{
        width: metric.railWidth,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: color.rail,
        borderRight: `1px solid ${color.line}`,
        // A short window must not hide the last entries: the rail is the only way
        // back to a closed part.
        overflowX: 'hidden',
        overflowY: 'auto'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {RAIL_SECTIONS.map((section, index) => (
          <div key={section.join()} style={{ display: 'flex', flexDirection: 'column' }}>
            {index > 0 && <Divider />}
            {section.map(renderPartItem)}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {RAIL_TRAILING.map(renderPartItem)}
        {extras.length > 0 && <Divider />}
        {extras.map((extra) => (
          <RailItem
            key={extra.id}
            icon={extra.icon}
            label={extra.label}
            title={extra.title}
            front={extra.active}
            onClick={extra.onClick}
          />
        ))}
        <Divider />
        <RailItem
          icon="layout"
          label="布局"
          title={
            dock.resetUndoable
              ? '撤销:回到恢复默认布局之前的排布'
              : `恢复默认布局 — ${PARTS.length} 个面板回到初始位置,可再点一次撤销`
          }
          front={false}
          onClick={() => (dock.resetUndoable ? dock.undoReset() : dock.reset())}
        />
      </div>
    </nav>
  )
}
