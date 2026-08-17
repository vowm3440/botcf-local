import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import { config } from './config.js'
import { getDb } from './db.js'
import { initSecrets } from './secure/store.js'
import { redact } from './secure/redact.js'
import { isTrustedLocalRequest } from './secure/localRequest.js'
import { appState, applyActiveRouteToOmp, restoreBotcfSession, restoreThirdParty, rearmRoute } from './appState.js'
import { startCredentialProxy } from './proxy/credentialProxy.js'
import { registerApiRoutes } from './routes/api.js'
import { onGenerationIdleOnce, registerChatRoutes } from './routes/chat.js'
import { registerFileRoutes } from './routes/files.js'
import { registerOmpRoutes, restoreWorkdir } from './routes/omp.js'
import { ompClient } from './omp/rpc.js'
import { OmpUpdater } from './omp/updater.js'

async function main(): Promise<void> {
  await initSecrets()
  getDb()

  const restored = restoreBotcfSession()
  const thirdRestored = restoreThirdParty()

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

  const updater = new OmpUpdater({
    isIdle: () => !appState.generationInFlight,
    onIdleOnce: onGenerationIdleOnce,
    healthProbe: async () => {
      await ompClient.stop()
      if (!ompClient.available) return false
      const started = await ompClient.start()
      if (!started || !(await ompClient.handshake())) return false
      const route = appState.route
      if (!route || !(await applyActiveRouteToOmp())) return false
      const provider = route.apiType === 'messages' ? 'botcf-messages' : route.apiType === 'chat' ? 'botcf-chat' : 'botcf-responses'
      return ompClient.smokeTest(provider, route.modelId)
    },
    log: (msg) => app.log.info(msg)
  })
  await updater.init()
  registerOmpRoutes(app, updater)

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
  restoreWorkdir()
  if (ompClient.available) {
    const started = await ompClient.start()
    if (started) {
      const ok = await ompClient.handshake()
      app.log.info(ok ? '[omp] RPC 握手成功' : `[omp] ${ompClient.lastProtocolError ?? 'RPC 握手失败'},已降级直连模式`)
    }
  }
  updater.startLoop()

  if (restored || thirdRestored) {
    rearmRoute()
      .then((ok) => app.log.info(`路由恢复: ${ok ? appState.route?.routeKey : '无已保存路由或恢复失败'}`))
      .catch(() => undefined)
  }

  app.log.info(`botcf-local ready on http://${config.host}:${config.port} (BotCF session restored: ${restored}, third-party restored: ${thirdRestored})`)
}

main().catch((err) => {
  console.error(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)))
  process.exit(1)
})
