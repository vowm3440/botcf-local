import type { GridPanelDef } from '../components/PanelGrid'
import DiagnosticsPanel from '../components/DiagnosticsPanel'
import GitPanel from '../components/GitPanel'
import ProjectConfigPanel from '../components/ProjectConfigPanel'
import ReviewPanel from '../components/ReviewPanel'
import TaskPanel from '../components/TaskPanel'
import TerminalPanel from '../components/TerminalPanel'
import { IDE_PANELS, type IdePanelId } from './panelVisibility'
import type { PanelToggles } from './usePanelToggles'

/** Panel definitions for the workbench features, in one place.
 *
 *  The chat page owns the grid; this module owns *what* the new panels are — their
 *  sizing hints, their close behaviour and their content — so adding a panel does
 *  not mean editing the chat page's render tree. Definitions are only produced for
 *  panels that are currently open: the grid takes the arrangement from there, and a
 *  closed panel must not stay mounted (a terminal or task stream would keep
 *  running behind a hidden panel). */

interface PanelShape {
  minWidth: number
  minHeight: number
  weight: number
  content: () => JSX.Element
}

const SHAPES: Record<IdePanelId, PanelShape> = {
  review: { minWidth: 320, minHeight: 220, weight: 2, content: () => <ReviewPanel /> },
  git: { minWidth: 320, minHeight: 220, weight: 2, content: () => <GitPanel /> },
  tasks: { minWidth: 300, minHeight: 200, weight: 2, content: () => <TaskPanel /> },
  terminal: { minWidth: 300, minHeight: 180, weight: 2, content: () => <TerminalPanel /> },
  diagnostics: { minWidth: 300, minHeight: 160, weight: 2, content: () => <DiagnosticsPanel /> },
  config: { minWidth: 300, minHeight: 220, weight: 2, content: () => <ProjectConfigPanel /> }
}

export function idePanelDefs(toggles: PanelToggles): GridPanelDef[] {
  return IDE_PANELS.filter((panel) => toggles.isVisible(panel.id)).map((panel) => {
    const shape = SHAPES[panel.id]
    return {
      id: panel.id,
      title: panel.title,
      minWidth: shape.minWidth,
      minHeight: shape.minHeight,
      weight: shape.weight,
      closable: true,
      onClose: () => toggles.hide(panel.id),
      content: shape.content()
    }
  })
}
