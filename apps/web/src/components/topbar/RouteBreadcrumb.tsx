import type { RouteInfo } from '../../api'
import { CAPTION, CHROME, CLUSTER, Picker, type PickerOption } from './chrome'
import type { TopBarData } from './useTopBarData'

/** The route, as a breadcrumb: 分组 › 模型 · 思考.
 *
 *  This is the one thing on the bar a user changes on purpose, so it gets the
 *  left edge and the only bold type in the chrome. Reading it left to right
 *  answers "what am I talking to", which is also the order the three choices
 *  depend on each other — a group scopes the models, a model scopes the thinking
 *  levels — so the breadcrumb is the dependency chain, not decoration.
 *
 *  Group descriptions used to be part of the option label and made the closed
 *  picker as wide as a sentence; they are tooltips now. */

export interface RouteBreadcrumbProps {
  data: TopBarData
  route: RouteInfo | null
  third: { baseUrl: string; models: string[] } | null
}

function Separator() {
  return (
    <span aria-hidden style={{ flex: 'none', color: '#d0d7de', fontSize: 12 }}>
      ›
    </span>
  )
}

function groupOptions(data: TopBarData): PickerOption[] {
  return data.groups.map((g) => ({
    value: g.name,
    label: `${g.name}${!g.usable ? ' · 不可用' : g.reason ? ' ⚠' : ''}`,
    disabled: !g.usable,
    title: g.reason ?? g.description
  }))
}

export default function RouteBreadcrumb({ data, route, third }: RouteBreadcrumbProps) {
  const { selectedModel } = data
  const noThinking = Boolean(selectedModel) && selectedModel?.thinkingLevels.length === 0

  return (
    <div style={{ ...CLUSTER, gap: 4, overflow: 'hidden' }}>
      {third ? (
        <span
          title={`第三方接口 ${third.baseUrl}`}
          style={{ ...CAPTION, flex: 'none', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          第三方 <span style={{ color: CHROME.inkSecondary }}>{third.baseUrl}</span>
        </span>
      ) : (
        <Picker
          ariaLabel="分组"
          value={data.group}
          placeholder="选择分组…"
          options={groupOptions(data)}
          onChange={data.selectGroup}
          onOpen={() => data.loadGroups()}
          disabled={data.busy}
          maxWidth={170}
          title={data.group ? `分组 ${data.group}` : '选择一个分组'}
        />
      )}

      <Separator />

      <Picker
        ariaLabel="模型"
        value={data.model}
        placeholder="选择模型…"
        options={data.models.map((m) => ({ value: m.id, label: m.id, title: m.contextLabel }))}
        onChange={data.selectModel}
        disabled={data.busy || !data.group}
        strong
        maxWidth={280}
        title={data.model || '选择一个模型'}
      />

      {noThinking ? (
        <span style={{ ...CAPTION, flex: 'none', paddingLeft: 4 }} title="该模型不支持思考等级">
          思考 —
        </span>
      ) : (
        <Picker
          ariaLabel="思考等级"
          value={data.thinking}
          placeholder="思考…"
          options={(selectedModel?.thinkingLevels ?? []).map((level) => ({ value: level, label: level }))}
          onChange={data.selectThinking}
          disabled={data.busy || !selectedModel}
          maxWidth={120}
          title="思考等级"
        />
      )}

      {route && (
        <span
          style={{ ...CAPTION, flex: 'none', paddingLeft: 4 }}
          title={`上下文窗口 ${route.effectiveContext.toLocaleString()} tokens · ${route.apiType}`}
        >
          {route.capabilityLabel}
        </span>
      )}
    </div>
  )
}
