import { BotcfClient } from './botcf/adapter.js'
import { ensureDedicatedKey } from './botcf/keys.js'
import { setActiveRoute } from './proxy/credentialProxy.js'
import { getSecret, putSecret, deleteSecret } from './db.js'
import { seal, open } from './secure/store.js'

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
}

export function persistRoute(): void {
  if (appState.route) putSecret(ROUTE_SECRET, seal(JSON.stringify(appState.route)))
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
    return true
  } catch {
    return false
  }
}
