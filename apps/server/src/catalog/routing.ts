import { normalizeGroupName } from '../botcf/keys.js'

export type ApiType = 'responses' | 'chat' | 'messages'

export interface GroupPolicy {
  apiType: ApiType
  /** false when BotCF marks the group as unusable outside its own client (e.g. Claude-Max). */
  usable: boolean
  /** true for image/video groups that must not appear in the OMP model picker. */
  hidden: boolean
  reason?: string
}

/** Classify a BotCF group. Names are matched after stripping emoji decorations,
 *  case-insensitively; BotCF adjusts groups over time so this is pattern-based
 *  rather than a hardcoded list. */
export function classifyGroup(group: string): GroupPolicy {
  const n = normalizeGroupName(group).toLowerCase()

  if (/(视频|video|image|生图|图片|imagine|banana|midjourney|mj)/.test(n) || /(视频|生图)/.test(group)) {
    return { apiType: 'chat', usable: false, hidden: true, reason: '图像/视频分组不进入 OMP 模型选择器' }
  }
  if (n.includes('codex')) {
    return { apiType: 'responses', usable: true, hidden: false }
  }
  if (n.includes('claude')) {
    // BotCF docs mark non-外接 Claude-Max as Claude-Code-only. Per user
    // request these stay selectable — the upstream may still reject
    // non-Claude-Code clients, so the reason is surfaced as a warning.
    const isExternal = n.includes('外接') || group.includes('外接')
    if (n.includes('max') && !isExternal) {
      return { apiType: 'messages', usable: true, hidden: false, reason: 'BotCF 标记为 Claude Code 专用,非 Claude Code 客户端可能被上游拒绝' }
    }
    return { apiType: 'messages', usable: true, hidden: false }
  }
  // gemini / grok / mixed groups: BotCF exposes them via OpenAI-compatible chat.
  return { apiType: 'chat', usable: true, hidden: false }
}

/** Model-level filter: models that make no sense in a coding-agent picker. */
export function isSelectableModel(modelId: string): boolean {
  return !/(image|imagine|banana|video|sora|embedding|tts|whisper|dall-e|midjourney)/i.test(modelId)
}

/** Thinking levels = intersection of what OMP supports (off|minimal|low|medium|
 *  high|xhigh|max), what the model family does, and what the BotCF route allows
 *  (BotCF documents low/medium/high for Codex). Chat-compat routes pick their
 *  thinking variant via the model id itself, so they expose no separate levels. */
export function supportedThinkingLevels(apiType: ApiType, modelId: string): string[] {
  if (apiType === 'responses') return ['low', 'medium', 'high']
  if (apiType === 'messages') return ['off', 'low', 'medium', 'high']
  void modelId
  return []
}

export function baseUrlFor(apiType: ApiType, botcfBaseUrl: string): string {
  return apiType === 'messages' ? botcfBaseUrl : `${botcfBaseUrl}/v1`
}

/** BotCF's /api/user/models returns EVERY model the account can reach, but a
 *  group only actually serves its own family — a codex key won't serve gemini.
 *  Filter the picker accordingly. Unknown/mixed groups keep everything. */
export function modelMatchesGroup(group: string, modelId: string): boolean {
  const g = normalizeGroupName(group).toLowerCase()
  const id = modelId.toLowerCase()
  if (g.includes('codex')) return /^(gpt-|codex|o\d)/.test(id)
  if (g.includes('claude')) return id.startsWith('claude')
  if (g.includes('gemini')) return id.startsWith('gemini')
  if (g.includes('grok') && !g.includes('mix')) return id.startsWith('grok')
  return true
}

/** Third-party custom provider mode: user-supplied base URL + key + models. */
export const THIRD_PARTY_GROUP = '第三方'

/** OMP handles thinking via set_thinking_level regardless of wire protocol,
 *  so third-party routes expose one fixed selectable set. */
export const THIRD_PARTY_THINKING_LEVELS = ['off', 'low', 'medium', 'high']

/** Wire protocol for a third-party model: claude family talks Anthropic
 *  messages, everything else OpenAI-compatible chat completions. */
export function thirdPartyApiType(modelId: string): ApiType {
  return modelId.toLowerCase().startsWith('claude') ? 'messages' : 'chat'
}

/** Normalize a user-pasted base URL: trim, drop trailing slashes and a
 *  trailing /v1 — the credential proxy appends wire paths itself. */
export function normalizeBaseUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '')
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  } catch {
    return null
  }
  return trimmed
}

/** Parse the user's model list: comma/semicolon/newline/space separated, deduped. */
export function parseModelList(input: string): string[] {
  const seen = new Set<string>()
  const models: string[] = []
  for (const part of input.split(/[\n\r,;\s]+/)) {
    const model = part.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }
  return models
}
