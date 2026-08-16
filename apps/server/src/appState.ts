import { BotcfClient } from './botcf/adapter.js'
import { ensureDedicatedKey } from './botcf/keys.js'
import { resetSiteCatalog } from './catalog/groupCatalog.js'
import { setActiveRoute } from './proxy/credentialProxy.js'
import { getSecret, putSecret, deleteSecret } from './db.js'
import { seal, open } from './secure/store.js'
import { ompClient, syncBotcfModelsConfig } from './omp/rpc.js'

export interface ActiveRouteInfo {
  group: string
  modelId: string
  apiType: 'responses' | 'chat' | 'messages'
  thinkingLevel: string | null
  routeKey: string
  tokenName: string
  capabilityLabel: string
  effectiveContext: number
}

/** Process-wide state shared by routes, proxy and updater. */
export const appState = {
  botcf: new BotcfClient(),
  route: null as ActiveRouteInfo | null,
  generationInFlight: false,
  currentAbort: null as AbortController | null,
  /** Cumulative OMP session token counters, for per-turn deltas. */
  lastOmpUsage: { input: 0, output: 0 }
}

const SESSION_SECRET = 'botcf.session-state'
const ROUTE_SECRET = 'botcf.active-route'

export function persistBotcfSession(): void {
  putSecret(SESSION_SECRET, seal(JSON.stringify(appState.botcf.exportState())))
}

export function restoreBotcfSession(): boolean {
  const sealed = getSecret(SESSION_SECRET)
  if (!sealed) return false
  try {
    appState.botcf.restoreState(JSON.parse(open(sealed)))
    return appState.botcf.authenticated
  } catch {
    return false
  }
}

export function clearBotcfSession(): void {
  deleteSecret(SESSION_SECRET)
  deleteSecret(ROUTE_SECRET)
  appState.botcf = new BotcfClient()
  appState.route = null
  resetSiteCatalog()
}

export function persistRoute(): void {
  if (appState.route) putSecret(ROUTE_SECRET, seal(JSON.stringify(appState.route)))
}

/** Apply the active BotCF route to OMP. Session switches and process restarts
 *  can restore OMP's persisted model, so every such boundary must reassert the
 *  proxy-backed provider/model pair. */
export async function applyActiveRouteToOmp(): Promise<boolean> {
  const route = appState.route
  if (!route) return false
  const configChanged = syncBotcfModelsConfig()
  if (configChanged && ompClient.running) {
    await ompClient.stop()
    const started = await ompClient.start()
    if (!started || !await ompClient.handshake()) return false
  }
  if (!ompClient.running) return false
  const provider = route.apiType === 'responses'
    ? 'botcf-responses'
    : route.apiType === 'messages'
      ? 'botcf-messages'
      : 'botcf-chat'
  await ompClient.setModel(provider, route.modelId)
  if (route.thinkingLevel) await ompClient.setThinkingLevel(route.thinkingLevel)
  const state = await ompClient.getState()
  if (state.model && (state.model.provider !== provider || state.model.id !== route.modelId)) {
    throw new Error(`OMP 状态校验失败: 期望 ${provider}/${route.modelId}, 实际 ${String(state.model.provider)}/${String(state.model.id)}`)
  }
  return true
}

/** After a restart the proxy has no credentials in memory. Restore the last
 *  route by re-fetching the dedicated key and re-arming the proxy, so the user
 *  lands back exactly where they left off. */
export async function rearmRoute(): Promise<boolean> {
  const sealed = getSecret(ROUTE_SECRET)
  if (!sealed || !appState.botcf.authenticated) return false
  try {
    const route = JSON.parse(open(sealed)) as ActiveRouteInfo
    const dedicated = await ensureDedicatedKey(appState.botcf, route.group)
    setActiveRoute({
      routeKey: route.routeKey,
      apiType: route.apiType,
      bearerKey: dedicated.key,
      modelId: route.modelId,
      group: route.group
    })
    appState.route = route
    try {
      await applyActiveRouteToOmp()
    } catch {
      await ompClient.stop()
    }
    return true
  } catch {
    return false
  }
}
