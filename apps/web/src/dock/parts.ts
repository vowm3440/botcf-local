import type { DockEdge } from './dockModel'
import type { IconName } from './icons'

/** The catalogue of dockable parts: one row per feature the workbench can show.
 *
 *  The layout used to hard-code where each feature lived — a file tree could only
 *  be a sidebar, a terminal could only be a bottom tab — which meant four
 *  container types with four sets of rules. Here a part is just a part: it names
 *  itself, states how small it may get, and says where it should reappear if the
 *  user closes it. The dock does the rest, identically for all of them.
 *
 *  `home` is the only remaining opinion about placement, and it is a *default*,
 *  not a constraint: drag anything anywhere. It exists so that reopening a closed
 *  part is predictable, and so parts that belong together land together — opening
 *  源代码管理 while 资源管理器 is docked left joins that group as a tab rather
 *  than carving out a second column. */

export type PartId =
  | 'explorer'
  | 'scm'
  | 'run'
  | 'review'
  | 'config'
  | 'editor'
  | 'problems'
  | 'terminal'
  | 'preview'
  | 'chat'

export interface PartMeta {
  id: PartId
  /** Tab caption and rail caption. Two to three characters. */
  label: string
  /** Full name, for the tooltip, the aria-label and the single-part title row. */
  title: string
  icon: IconName
  hint: string
  /** Where this part reappears when it is reopened from the rail. */
  home: DockEdge | 'center'
  /** Smallest useful size, in CSS pixels. The sash refuses to go below it. */
  minWidth: number
  minHeight: number
  /** Keep the component mounted while its tab is in the background.
   *
   *  Only for parts whose state lives in the DOM and cannot be replayed: the
   *  editor's scroll offsets and unsaved buffers, the transcript's scroll
   *  position. Everything else re-mounts from the server on demand, which is why
   *  a hidden terminal is not quietly consuming a stream. */
  keepMounted?: boolean
}

export const PARTS: readonly PartMeta[] = Object.freeze([
  {
    id: 'explorer',
    label: '资源',
    title: '资源管理器',
    icon: 'explorer',
    hint: '工作区文件:浏览、打开、增删,本轮被改动的文件带标记',
    home: 'left',
    minWidth: 200,
    minHeight: 120
  },
  {
    id: 'scm',
    label: '源码',
    title: '源代码管理',
    icon: 'scm',
    hint: 'Git 状态、差异、暂存、提交与回滚',
    home: 'left',
    minWidth: 240,
    minHeight: 140
  },
  {
    id: 'run',
    label: '运行',
    title: '运行和任务',
    icon: 'run',
    hint: '构建 / 运行 / 测试:来自项目配置与 package.json 脚本',
    home: 'left',
    minWidth: 240,
    minHeight: 140
  },
  {
    id: 'review',
    label: '审查',
    title: 'AI 修改审查',
    icon: 'review',
    hint: '逐个文件查看 AI 的修改,接受或撤销,再一起提交',
    home: 'left',
    minWidth: 260,
    minHeight: 160
  },
  {
    id: 'config',
    label: '配置',
    title: '项目配置',
    icon: 'config',
    hint: '每个目录的 .botcf/config.json:任务、预览、终端、审查',
    home: 'left',
    minWidth: 280,
    minHeight: 180
  },
  {
    id: 'editor',
    label: '编辑器',
    title: '编辑器',
    icon: 'editor',
    hint: '打开的文件与差异,多标签并排',
    home: 'center',
    minWidth: 320,
    minHeight: 160,
    keepMounted: true
  },
  {
    id: 'problems',
    label: '问题',
    title: '问题',
    icon: 'problems',
    hint: '任务、预览、AI 运行时与页面报错的统一列表',
    home: 'bottom',
    minWidth: 260,
    minHeight: 120
  },
  {
    id: 'terminal',
    label: '终端',
    title: '终端',
    icon: 'terminal',
    hint: '在工作区目录里运行命令(逐行执行,无 PTY)',
    home: 'bottom',
    minWidth: 280,
    minHeight: 120
  },
  {
    id: 'preview',
    label: '预览',
    title: '实时预览',
    icon: 'preview',
    hint: '启动开发服务器,在内嵌视图里实时预览',
    home: 'bottom',
    minWidth: 320,
    minHeight: 200
  },
  {
    id: 'chat',
    label: '对话',
    title: 'AI 对话',
    icon: 'chat',
    hint: '与模型对话,工具调用与本轮变更都在这里',
    home: 'right',
    minWidth: 300,
    minHeight: 220,
    keepMounted: true
  }
] as const)

/** Rail order, in sections: navigate the project, then look at output, then talk
 *  to the model. Sections are how the rail stays readable without labels. */
export const RAIL_SECTIONS: readonly (readonly PartId[])[] = Object.freeze([
  Object.freeze(['explorer', 'scm', 'run', 'review', 'config'] as const),
  Object.freeze(['editor', 'problems', 'terminal', 'preview'] as const)
])

/** Docked bottom-of-rail entries: the assistant, which is a part like any other. */
export const RAIL_TRAILING: readonly PartId[] = Object.freeze(['chat'] as const)

const PART_IDS: readonly string[] = PARTS.map((part) => part.id)
const BY_ID = new Map<string, PartMeta>(PARTS.map((part) => [part.id, part] as const))

export const ALL_PART_IDS: readonly PartId[] = Object.freeze(PARTS.map((part) => part.id))

export function isPartId(value: unknown): value is PartId {
  return typeof value === 'string' && PART_IDS.includes(value)
}

export function partMeta(id: PartId): PartMeta {
  return BY_ID.get(id) ?? PARTS[0]
}

/** Metadata for an id that may not be a part at all, for code paths reading a
 *  stored layout. */
export function partMetaOrNull(id: string): PartMeta | null {
  return BY_ID.get(id) ?? null
}
