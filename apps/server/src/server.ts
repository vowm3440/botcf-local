import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { config } from './config.js'
import { getDb } from './db.js'
import { refreshMaxOutputs } from './catalog/capability.js'
import { diagnosticsCenter } from './diagnostics/center.js'
import { initSecrets } from './secure/store.js'
import { redact } from './secure/redact.js'
import { isTrustedLocalRequest } from './secure/localRequest.js'
import { appState, restoreBotcfSession, restoreThirdParty, rearmRoute } from './appState.js'
import { appEvents } from './appEvents.js'
import { startCredentialProxy } from './proxy/credentialProxy.js'
import { registerApiRoutes } from './routes/api.js'
import { onGenerationIdleOnce, registerChatRoutes } from './routes/chat.js'
import { registerDiagnosticsRoutes } from './routes/diagnostics.js'
import { registerFileRoutes } from './routes/files.js'
import { registerGitRoutes } from './routes/git.js'
import { registerOmpRoutes } from './routes/omp.js'
import { registerPreviewRoutes } from './routes/preview.js'
import { registerProjectConfigRoutes } from './routes/projectConfig.js'
import { registerReviewRoutes } from './routes/review.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerTerminalRoutes } from './routes/terminal.js'
import { registerWorkspaceRoutes } from './routes/workspace.js'
import { previewManager, registerPreviewShutdown, type PreviewState } from './preview/manager.js'
import { registerTaskShutdown } from './tasks/manager.js'
import { registerTerminalShutdown } from './terminal/registry.js'
import { ompClient } from './omp/rpc.js'
import { describeStartupBudget } from './omp/startupBudget.js'
import { restartRuntime } from './omp/runtime.js'
import { OmpUpdater, type OmpUpdateEvent } from './omp/updater.js'
import { restoreWorkspace } from './workspace/store.js'

function configureNetworkProxy(): void {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent())
  }
}

/** Feed the runtime's own failures into the diagnostics center, so the panel is
 *  one place for everything that went wrong — not just compiler output. */
function collectRuntimeDiagnostics(updater: OmpUpdater): void {
  let lastPreviewError: string | null = null
  previewManager.on('state', (state: PreviewState) => {
    if (state.phase !== 'error' || !state.error) {
      lastPreviewError = null
      return
    }
    if (state.error === lastPreviewError) return
    lastPreviewError = state.error
    diagnosticsCenter.note({
      origin: 'preview',
      source: '实时预览',
      message: state.error,
      tool: state.mode ?? 'preview'
    })
  })
  ompClient.on('exit', (code: number | null) => {
    if (code === 0 || code === null) return
    diagnosticsCenter.note({ origin: 'agent', source: 'OMP', message: `OMP 进程退出,code=${code}`, tool: 'omp' })
  })
  updater.on('update', (event: OmpUpdateEvent) => {
    if (event.phase !== 'error' && event.phase !== 'rolled-back') return
    diagnosticsCenter.note({
      origin: 'agent',
      source: 'OMP 更新',
      severity: event.phase === 'error' ? 'error' : 'warning',
      message: `${event.phase === 'error' ? '更新失败' : '已回滚到上一版本'}${event.version ? ` (${event.version})` : ''}${event.error ? `: ${event.error}` : ''}`,
      tool: 'updater'
    })
  })
}

async function main(): Promise<void> {
  configureNetworkProxy()
  await initSecrets()
  getDb()
  // Output caps are derived, so recompute them on every boot: routes stored
  // before the cap became family-aware carry a value that starves reasoning
  // models of the budget they need to finish a turn.
  const refreshedCaps = refreshMaxOutputs()

  const restored = restoreBotcfSession()
  const thirdRestored = restoreThirdParty()
  // Set before the HTTP server starts listening: a page that loads while the
  // route is still being re-armed must be able to tell "no route" apart from
  // "route not restored yet".
  appState.restoring = restored || thirdRestored

  const app = Fastify({
    logger: {
      level: 'info',
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '***' }
    },
    bodyLimit: 32 * 1024 * 1024
  })
  app.addHook('onRequest', async (req, reply) => {
    if (!isTrustedLocalRequest(req.headers.host, req.headers.origin)) {
      return reply.code(403).send({ success: false, error: '仅允许同源回环访问' })
    }
  })

  app.get('/health', async () => ({ status: 'ok' }))

  registerApiRoutes(app)
  registerChatRoutes(app)
  registerFileRoutes(app)
  registerWorkspaceRoutes(app)
  registerPreviewRoutes(app)
  registerGitRoutes(app)
  registerTerminalRoutes(app)
  registerTaskRoutes(app)
  registerReviewRoutes(app)
  registerProjectConfigRoutes(app)
  registerDiagnosticsRoutes(app)
  // Child processes (dev server, tasks, shells) must be released before exit.
  registerPreviewShutdown()
  registerTaskShutdown()
  registerTerminalShutdown()

  const updater = new OmpUpdater({
    isIdle: () => !appState.generationInFlight,
    onIdleOnce: onGenerationIdleOnce,
    healthProbe: async () => {
      // Same entry point as a primary-root switch and an explicit restart: the
      // swapped binary is only healthy once it handshakes *and* carries the
      // active route again.
      if ((await restartRuntime()).status !== 'restarted') return false
      const route = appState.route
      // A fresh installation has no login/model route yet. The RPC handshake
      // is the complete offline health check; run the real prompt once a route
      // exists and credentials can be injected through the local proxy.
      if (!route) return true
      const provider = route.apiType === 'messages' ? 'botcf-messages' : route.apiType === 'chat' ? 'botcf-chat' : 'botcf-responses'
      return ompClient.smokeTest(provider, route.modelId)
    },
    log: (msg) => app.log.info(msg)
  })
  await updater.init()
  registerOmpRoutes(app, updater)
  collectRuntimeDiagnostics(updater)

  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, { root: config.webDistDir, prefix: '/' })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ success: false, error: 'not found' })
      } else {
        reply.sendFile('index.html')
      }
    })
  }

  await startCredentialProxy()
  await app.listen({ host: config.host, port: config.port })

  ompClient.on('stderr', (line: string) => app.log.info(`[omp] ${redact(String(line))}`))
  ompClient.on('exit', (code: number | null) => app.log.warn(`[omp] 进程退出 code=${code}`))
  // Restores the multi-root workspace (migrating the legacy single workdir) and
  // points OMP's cwd at the primary root before the process starts.
  const workspace = restoreWorkspace()
  app.log.info(`[workspace] ${workspace.roots.length} 个目录,主目录: ${ompClient.workdir ?? '默认'}`)
  if (ompClient.available) {
    app.log.info(`[omp] ${describeStartupBudget()}`)
    const started = await ompClient.start()
    if (started) {
      const ok = await ompClient.handshake()
      app.log.info(
        ok
          ? `[omp] RPC 握手成功 (spawn→ready ${ompClient.lastReadyMs ?? '?'} ms)`
          : `[omp] ${ompClient.lastProtocolError ?? 'RPC 握手失败'},已降级直连模式`
      )
    }
  }
  updater.startLoop()

  if (restored || thirdRestored) {
    // The browser cannot poll its way out of this: it has no way of knowing a
    // restoration is pending. Clearing `restoring` and pushing a state_changed
    // frame covers both the page that is already open and the one that connects
    // after the event fired (it reads `restoring: false` with the route in place).
    rearmRoute()
      .then((ok) => {
        app.log.info(`路由恢复: ${ok ? appState.route?.routeKey : '无已保存路由或恢复失败'}`)
        appState.restoring = false
        appEvents.emitStateChanged(ok ? 'route-restored' : 'route-restore-failed')
      })
      .catch(() => {
        appState.restoring = false
        appEvents.emitStateChanged('route-restore-failed')
      })
  }

  app.log.info(`botcf-local ready on http://${config.host}:${config.port} (BotCF session restored: ${restored}, third-party restored: ${thirdRestored})`)
  if (refreshedCaps > 0) app.log.info(`[capability] 已刷新 ${refreshedCaps} 条路由的输出上限`)
}

main().catch((err) => {
  console.error(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)))
  process.exit(1)
})
