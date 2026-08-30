'use strict'

/** The real app, started for real, so a harness can drive it.
 *
 *  Two harnesses need the same thing and neither of them is the app: the perf gate
 *  (perf/editor-load.cjs) measures the editor under load, and the editor E2E
 *  (e2e/editor.cjs) asserts that CodeMirror's decorations, gutter and read-only mode
 *  behave. Both want a build, a server on a scratch port with a scratch data
 *  directory, an authenticated session, a workspace root and a real Electron window
 *  pointed at the same page the desktop shell opens — and neither wants to reach the
 *  network while it runs.
 *
 *  That is this file. It was extracted from the gate rather than written for the E2E,
 *  so everything here is the shape a measurement run needed, including the parts that
 *  look like paranoia and are not:
 *
 *  - Every wait has a ceiling. Two early runs of the gate sat at "driving the editor…"
 *    forever with no result file and nothing to diagnose, because a renderer waited on
 *    a frame callback that never came and nothing above it had a deadline. A harness
 *    that can hang cannot prove anything, so the ceilings are load-bearing.
 *  - Frame callbacks stop for a page Chromium considers hidden, and on Windows a
 *    window another window covers counts as occluded. `backgroundThrottling: false`
 *    does not cover that path, so the switches below do.
 *  - The updater checks GitHub on start and would install an agent binary mid-run, so
 *    both proxy variables point at a dead port. A harness must not race a download.
 *
 *  Nothing here judges anything. It starts the app and hands back the window. */

const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { removeDirectory } = require('./tempDir.cjs')

const REPO = path.resolve(__dirname, '..')

/** Third-party mode is the one that becomes authenticated without an upstream call,
 *  which is exactly right for a harness that never talks to a model. */
const THIRD_PARTY_GROUP = '第三方'
const HARNESS_MODEL = 'harness-model'

/** Must run before `app.whenReady()`, so every entry point calls it at module load.
 *
 *  `--expose-gc` is here rather than in the gate because "what is still held" is
 *  indistinguishable from "what V8 has not got round to freeing" without a way to
 *  force a collection, and an idle window is not a reason for it to. */
function applyChromiumSwitches() {
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('js-flags', '--expose-gc')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Every await in a harness goes through here. Without it a single unbounded
 *  promise takes the whole run down with it, silently. */
function withTimeout(promise, ms, label) {
  let timer = null
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 (${Math.round(ms / 1000)}s)`)), ms)
  })
  return Promise.race([promise, ceiling]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** Neither harness builds; both refuse to run against a stale one. */
function requireBuild() {
  const server = path.join(REPO, 'apps', 'server', 'dist', 'server.js')
  const web = path.join(REPO, 'apps', 'web', 'dist', 'index.html')
  for (const file of [server, web]) {
    if (!fs.existsSync(file)) throw new Error(`missing ${path.relative(REPO, file)} — run \`npm run build\` first`)
  }
  return { server, web: path.dirname(web) }
}

/** @param {{ label: string, port: number, proxyPort: number, dataDir: string,
 *            budget?: { serverHealth?: number, pageLoad?: number, workbench?: number } }} options */
function createHarness(options) {
  const { label, port, proxyPort, dataDir } = options
  const budget = {
    serverHealth: 30_000,
    pageLoad: 60_000,
    workbench: 30_000,
    ...(options.budget ?? {})
  }
  const base = `http://127.0.0.1:${port}`
  let serverProc = null
  let cleanupPromise = null

  function log(message) {
    process.stdout.write(`[${label}] ${message}\n`)
  }

  function startServer(build) {
    fs.rmSync(dataDir, { recursive: true, force: true })
    serverProc = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [build.server], {
      cwd: path.join(REPO, 'apps', 'server'),
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        PROXY_PORT: String(proxyPort),
        BOTCF_DATA_DIR: dataDir,
        WEB_DIST_DIR: build.web,
        // A harness run must not reach the network: the updater checks GitHub on
        // start and a fresh data directory would have it install an agent binary
        // mid-run. A dead proxy fails those requests immediately.
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    })
    serverProc.stdout.on('data', () => {})
    serverProc.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))
    serverProc.on('exit', (code) => {
      serverProc = null
      if (code !== 0 && code !== null) log(`server exited with ${code}`)
    })
  }

  /** Resolves once the server process is really gone. `rmSync` on the data
   *  directory fails with EPERM while it still holds the SQLite file open, so the
   *  wait is part of the cleanup, not politeness. */
  function stopServer() {
    const child = serverProc
    serverProc = null
    if (!child || child.exitCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      let force = null
      const done = () => {
        if (force) clearTimeout(force)
        resolve()
      }
      child.once('exit', done)
      force = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        setTimeout(resolve, 500)
      }, 3_000)
      try {
        child.kill()
      } catch {
        done()
      }
    })
  }

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: urlPath,
          headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode >= 400) return reject(new Error(`${method} ${urlPath} → HTTP ${res.statusCode}: ${text}`))
            try {
              resolve(JSON.parse(text))
            } catch {
              resolve({ raw: text })
            }
          })
        }
      )
      req.on('error', reject)
      req.setTimeout(30_000, () => {
        req.destroy(new Error(`${method} ${urlPath} timed out`))
      })
      if (payload) req.write(payload)
      req.end()
    })
  }

  async function waitForHealth() {
    const until = Date.now() + budget.serverHealth
    let lastError = null
    while (Date.now() < until) {
      try {
        await request('GET', '/health')
        return
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    throw new Error(`本地服务在 ${Math.round(budget.serverHealth / 1000)}s 内未就绪${lastError ? `: ${lastError.message}` : ''}`)
  }

  /** The workbench only renders for an authenticated session, and the composer is
   *  disabled without an active route — which a harness that drives the assistant
   *  needs. Third-party mode gives both without an upstream call: an unreachable
   *  endpoint is exactly right when nothing here talks to a model. */
  async function seedSession() {
    await request('POST', '/api/auth/third-party', {
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'harness-not-a-real-key',
      models: HARNESS_MODEL
    })
    await request('POST', '/api/route', { group: THIRD_PARTY_GROUP, model: HARNESS_MODEL })
  }

  function addRoot(dir, primary = true) {
    return request('POST', '/api/workspace/roots', { path: dir, primary })
  }

  function createWindow({ show = true, width = 1200, height = 820 } = {}) {
    const window = new BrowserWindow({
      width,
      height,
      show,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Frame callbacks are the clock in a measurement run: a throttled window
        // reports latencies that are really just the throttle interval.
        backgroundThrottling: false
      }
    })
    // Occlusion is what stops frame callbacks on a shown-but-covered window, and
    // an uninterruptible wait on one is what hung the gate twice.
    if (show) {
      window.show()
      window.moveTop()
    }
    return window
  }

  /** Load the page, then throw away anything a previous run left in browser storage
   *  and load it again.
   *
   *  The window's origin is fixed (127.0.0.1:<port>), so `localStorage` survives from
   *  one run to the next — and the workbench keeps two things there that decide what a
   *  run sees: the dock arrangement and the open editor tabs. Both have already caused
   *  a false failure. The rail is a *toggle*, so a run that ended with the Git panel in
   *  front made the next run's click close it instead of opening it, and the checks
   *  timed out waiting for a panel that had just been dismissed. Leftover tabs would be
   *  worse in the gate: the baseline is supposed to be an *empty* workbench, and it is
   *  sampled before anything is opened.
   *
   *  A run must not depend on how the last one happened to end. */
  async function loadApp(window, { freshProfile = true } = {}) {
    await withTimeout(window.loadURL(base), budget.pageLoad, '加载页面')
    if (!freshProfile) return
    await withTimeout(
      window.webContents.executeJavaScript(
        'try { localStorage.clear(); sessionStorage.clear() } catch { /* storage may be unavailable */ } true'
      ),
      30_000,
      '清空浏览器存储'
    )
    await withTimeout(window.loadURL(base), budget.pageLoad, '重新加载页面')
  }

  /** The page finishing `loadURL` is not the workbench being ready: the panels mount
   *  after the session and workspace requests resolve, and the listener that opens
   *  files is registered by that subtree. Waiting for it is what makes a baseline
   *  sample describe a workbench that is mounted, idle and empty rather than one
   *  still loading. */
  async function waitForWorkbench(webContents) {
    const until = Date.now() + budget.workbench
    let lastError = null
    while (Date.now() < until) {
      try {
        const ready = await webContents.executeJavaScript(
          'Boolean(document.querySelector(\'[role="tablist"][aria-label="面板标签"]\'))'
        )
        if (ready) return
      } catch (error) {
        lastError = error
      }
      await delay(200)
    }
    throw new Error(`空工作台在 ${Math.round(budget.workbench / 1000)}s 内未就绪${lastError ? `: ${lastError.message}` : ''}`)
  }

  /** A driver pushes its stage over the console channel so a run that dies without
   *  returning still says where it was. Kept with a timestamp per stage, because a
   *  measurement that wants to attribute memory to a phase needs to know when the
   *  phase started. Electron changed this event's signature (positional args → a
   *  details object), so accept both. */
  function trackStages(webContents) {
    const stages = [{ stage: 'not-started', elapsedMs: 0, at: Date.now() }]
    webContents.on('console-message', (...args) => {
      const message = typeof args[1] === 'object' && args[1] !== null ? args[1].message : args[2]
      if (typeof message !== 'string' || !message.startsWith('[perf-stage]')) return
      try {
        stages.push({ ...JSON.parse(message.slice('[perf-stage]'.length)), at: Date.now() })
      } catch {
        // A malformed frame is not worth failing the run over.
      }
    })
    return {
      stages,
      last: () => stages[stages.length - 1],
      /** Wall-clock time the named stage was entered, or null. */
      at: (name) => stages.find((entry) => entry.stage === name)?.at ?? null
    }
  }

  async function teardown({ keepData = false } = {}) {
    await stopServer()
    if (keepData) return
    await removeDirectory(dataDir, (error) => log(`临时 data 目录未能删除 (${dataDir}): ${error.message}`))
  }

  /** Idempotent *and* awaitable. Both matter: `window-all-closed` and the run's own
   *  exit path both call this, a second call used to repeat the whole teardown, and a
   *  second caller that returned early would let `app.exit` cut the first call's
   *  directory removal short. */
  function cleanup(options) {
    if (!cleanupPromise) cleanupPromise = teardown(options)
    return cleanupPromise
  }

  return {
    base,
    dataDir,
    log,
    request,
    startServer,
    stopServer,
    waitForHealth,
    seedSession,
    addRoot,
    createWindow,
    loadApp,
    waitForWorkbench,
    trackStages,
    cleanup
  }
}

module.exports = {
  REPO,
  THIRD_PARTY_GROUP,
  HARNESS_MODEL,
  applyChromiumSwitches,
  createHarness,
  delay,
  withTimeout,
  requireBuild,
  removeDirectory
}
