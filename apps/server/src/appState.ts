import { BotcfClient } from './botcf/adapter.js'
import { ensureDedicatedKey } from './botcf/keys.js'
import { resetSiteCatalog } from './catalog/groupCatalog.js'
import { THIRD_PARTY_GROUP } from './catalog/routing.js'
import { resetSiteStatus } from './catalog/siteStatus.js'
import { setActiveRoute } from './proxy/credentialProxy.js'
import { getSecret, putSecret, deleteSecret } from './db.js'
import { seal, open } from './secure/store.js'
import { ompClient, syncBotcfModelsConfig, type OmpState } from './omp/rpc.js'

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

/** Third-party custom provider (user-supplied endpoint). The API key is only
 *  ever stored sealed; this public shape never carries it. */
export interface ThirdPartyInfo {
  baseUrl: string
  models: string[]
}

/** Process-wide state shared by routes, proxy and updater. */
export const appState = {
  botcf: new BotcfClient(),
  thirdParty: null as ThirdPartyInfo | null,
  route: null as ActiveRouteInfo | null,
  /** True while startup restoration (workspace → OMP → route) is still running.
   *  The HTTP server is already accepting requests at that point, so the first
   *  `/api/state` a page reads can legitimately carry `route: null`; the flag
   *  tells the client that answer is not final yet. */
  restoring: false,
  generationInFlight: false,
  currentAbort: null as AbortController | null,
  /** Cumulative OMP session token counters, for per-turn deltas. */
  lastOmpUsage: { input: 0, output: 0 }
}

/** Either mode counts as logged in for the control plane and chat. */
export function isAuthenticated(): boolean {
  return appState.botcf.authenticated || appState.thirdParty !== null
}

const SESSION_SECRET = 'botcf.session-state'
const ROUTE_SECRET = 'botcf.active-route'
const THIRD_PARTY_SECRET = 'thirdparty.provider'

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
  deleteSecret(THIRD_PARTY_SECRET)
  appState.botcf = new BotcfClient()
  appState.thirdParty = null
  appState.route = null
  setActiveRoute(null)
  resetSiteCatalog()
  resetSiteStatus()
}

/** Persist the third-party provider (key sealed) and activate the mode. */
export function setThirdParty(info: { baseUrl: string; models: string[]; apiKey: string }): void {
  const sealed = seal(JSON.stringify(info))
  clearBotcfSession()
  putSecret(THIRD_PARTY_SECRET, sealed)
  appState.thirdParty = { baseUrl: info.baseUrl, models: info.models }
}

/** Unseal the third-party API key on demand — never held on appState. */
export function getThirdPartyKey(): string | null {
  const sealed = getSecret(THIRD_PARTY_SECRET)
  if (!sealed) return null
  try {
    const parsed = JSON.parse(open(sealed)) as { apiKey?: string }
    return typeof parsed.apiKey === 'string' && parsed.apiKey ? parsed.apiKey : null
  } catch {
    return null
  }
}

export function restoreThirdParty(): boolean {
  const sealed = getSecret(THIRD_PARTY_SECRET)
  if (!sealed) return false
  try {
    const parsed = JSON.parse(open(sealed)) as { baseUrl?: string; models?: string[] }
    if (typeof parsed.baseUrl !== 'string' || !Array.isArray(parsed.models) || parsed.models.length === 0) return false
    appState.thirdParty = { baseUrl: parsed.baseUrl, models: parsed.models.filter((m): m is string => typeof m === 'string') }
    return true
  } catch {
    return false
  }
}

export function persistRoute(): void {
  if (appState.route) putSecret(ROUTE_SECRET, seal(JSON.stringify(appState.route)))
}

/** What applying a route needs of the agent runtime. `OmpRpcClient` satisfies it;
 *  naming it lets a test drive the real RPC wire against a scripted OMP process
 *  instead of stubbing the step this function exists to perform. */
export interface RouteTarget {
  readonly running: boolean
  stop: () => Promise<void>
  start: () => Promise<boolean>
  handshake: () => Promise<boolean>
  setModel: (provider: string, modelId: string) => Promise<unknown>
  setThinkingLevel: (level: string) => Promise<unknown>
  getState: () => Promise<OmpState>
}

/** Apply the active BotCF route to OMP. Session switches and process restarts
 *  can restore OMP's persisted model, so every such boundary must reassert the
 *  proxy-backed provider/model pair. */
export async function applyActiveRouteToOmp(
  client: RouteTarget = ompClient,
  syncModelsConfig: () => boolean = syncBotcfModelsConfig
): Promise<boolean> {
  const route = appState.route
  if (!route) return false
  const configChanged = syncModelsConfig()
  if (configChanged && client.running) {
    await client.stop()
    const started = await client.start()
    if (!started || !await client.handshake()) return false
  }
  if (!client.running) return false
  const provider = route.apiType === 'responses'
    ? 'botcf-responses'
    : route.apiType === 'messages'
      ? 'botcf-messages'
      : 'botcf-chat'
  await client.setModel(provider, route.modelId)
  if (route.thinkingLevel) await client.setThinkingLevel(route.thinkingLevel)
  const state = await client.getState()
  if (state.model && (state.model.provider !== provider || state.model.id !== route.modelId)) {
    throw new Error(`OMP 状态校验失败: 期望 ${provider}/${route.modelId}, 实际 ${String(state.model.provider)}/${String(state.model.id)}`)
  }
  return true
}

/** After a restart the proxy has no credentials in memory. Restore the last
 *  route by re-arming the proxy (BotCF: re-fetch the dedicated key; third-
 *  party: unseal the stored key), so the user lands back where they left off. */
export async function rearmRoute(): Promise<boolean> {
  const sealed = getSecret(ROUTE_SECRET)
  if (!sealed) return false
  try {
    const route = JSON.parse(open(sealed)) as ActiveRouteInfo
    if (route.group === THIRD_PARTY_GROUP) {
      const key = getThirdPartyKey()
      if (!appState.thirdParty || !key) return false
      setActiveRoute({
        routeKey: route.routeKey,
        apiType: route.apiType,
        bearerKey: key,
        modelId: route.modelId,
        group: route.group,
        baseUrl: appState.thirdParty.baseUrl
      })
    } else {
      if (!appState.botcf.authenticated) return false
      const dedicated = await ensureDedicatedKey(appState.botcf, route.group)
      setActiveRoute({
        routeKey: route.routeKey,
        apiType: route.apiType,
        bearerKey: dedicated.key,
        modelId: route.modelId,
        group: route.group
      })
    }
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
