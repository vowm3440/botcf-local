/** Which workbench panels are open.
 *
 *  The chat page hosts a growing set of panels — files, editor, preview, git,
 *  terminal, tasks, review, config, diagnostics — and the arrangement itself is
 *  owned by the panel grid. This module owns only the *visibility* question, as a
 *  pure model plus its persisted form, so restoring a session and toggling a panel
 *  are testable without React. */

export type IdePanelId = 'git' | 'terminal' | 'tasks' | 'review' | 'config' | 'diagnostics'

export interface IdePanelMeta {
  id: IdePanelId
  /** Toggle button label. */
  label: string
  /** Panel header title. */
  title: string
  hint: string
}

export const IDE_PANELS: readonly IdePanelMeta[] = [
  { id: 'review', label: '审查', title: 'AI 修改审查', hint: '逐个文件查看 AI 的修改,接受或撤销,再一起提交' },
  { id: 'git', label: 'Git', title: 'Git 状态', hint: '状态、差异、暂存、提交与回滚' },
  { id: 'tasks', label: '任务', title: '构建 / 运行 / 测试', hint: '统一任务系统:来自项目配置与 package.json 脚本' },
  { id: 'terminal', label: '终端', title: '内置终端', hint: '在工作区目录里运行命令(逐行执行,无 PTY)' },
  { id: 'diagnostics', label: '诊断', title: '错误与诊断中心', hint: '任务、预览、AI 运行时与页面报错的统一列表' },
  { id: 'config', label: '项目配置', title: '项目级配置', hint: '每个目录的 .botcf/config.json:任务、预览、终端、审查' }
]

export type PanelVisibility = Readonly<Record<IdePanelId, boolean>>

const IDS: readonly IdePanelId[] = IDE_PANELS.map((panel) => panel.id)

export const ALL_HIDDEN: PanelVisibility = Object.freeze(
  Object.fromEntries(IDS.map((id) => [id, false])) as Record<IdePanelId, boolean>
)

export function isIdePanelId(value: unknown): value is IdePanelId {
  return typeof value === 'string' && (IDS as readonly string[]).includes(value)
}

/** Restore from localStorage. Unknown ids are dropped and a corrupt entry
 *  degrades to "everything closed" rather than throwing on startup. */
export function parseStoredVisibility(raw: string | null): PanelVisibility {
  if (!raw) return ALL_HIDDEN
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ALL_HIDDEN
  }
  if (Array.isArray(parsed)) {
    // Older/simpler form: a list of open panel ids.
    const open = new Set(parsed.filter(isIdePanelId))
    return Object.fromEntries(IDS.map((id) => [id, open.has(id)])) as PanelVisibility
  }
  if (!parsed || typeof parsed !== 'object') return ALL_HIDDEN
  const record = parsed as Record<string, unknown>
  return Object.fromEntries(IDS.map((id) => [id, record[id] === true])) as PanelVisibility
}

export function serializeVisibility(visibility: PanelVisibility): string {
  return JSON.stringify(visiblePanels(visibility))
}

export function visiblePanels(visibility: PanelVisibility): IdePanelId[] {
  return IDS.filter((id) => visibility[id])
}

export function setPanel(visibility: PanelVisibility, id: IdePanelId, visible: boolean): PanelVisibility {
  if (visibility[id] === visible) return visibility
  return { ...visibility, [id]: visible }
}

export function togglePanel(visibility: PanelVisibility, id: IdePanelId): PanelVisibility {
  return setPanel(visibility, id, !visibility[id])
}

export function panelMeta(id: IdePanelId): IdePanelMeta {
  return IDE_PANELS.find((panel) => panel.id === id) ?? IDE_PANELS[0]
}
