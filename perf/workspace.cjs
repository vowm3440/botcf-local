'use strict'

/** Workspace lifecycle measurement: many roots open, and fifty open/remove cycles,
 *  against the real server and the real workbench.
 *
 *  The editor gate (perf/editor-load.cjs) measures how much one loaded editor costs;
 *  this one measures what the stage-3 resource layer costs when the workspace
 *  scales: opening 1 / 4 / N roots, and then churning 50 roots open and closed
 *  again. The agent pool and the per-root state machine are server-side, so the
 *  load-bearing numbers here are the *server's* working set and Windows handle
 *  count across those cycles, plus the renderer's JS heap after a forced
 *  collection — the two places a root-list leak would show up.
 *
 *  OMP itself is deliberately not driven here: the harness points the updater at a
 *  dead proxy (see harness/app.cjs), so no agent can start, and the pool would
 *  report `running: 0` for a reason that has nothing to do with the code under
 *  test. Pool capacity is still asserted as an invariant over the runtime
 *  snapshot; real agent-process accounting is exercised in the workspace/runtime
 *  unit tests and in an Electron session with a reachable runtime.
 *
 *  Run with `npm run perf:workspace`. Defaults hide the window (nothing here
 *  measures frame latency, so there is no reason to cover your screen); pass
 *  --show to watch. Every wait has a ceiling and the whole run has one, same
 *  reasoning as the editor gate: a harness that can hang cannot prove anything.
 *
 *  Flags: --keep, --show / --no-show, --json <file>, --budget <ms>,
 *  --roots <n> (default 8), --cycles <n> (default 50). */

const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { REPO, applyChromiumSwitches, createHarness, delay, requireBuild, withTimeout } = require('../harness/app.cjs')

const PORT = Number(process.env.PERF_WS_PORT ?? 7795)
const PROXY_PORT = Number(process.env.PERF_WS_PROXY_PORT ?? 7794)
const DATA_DIR = path.join(os.tmpdir(), 'botcf-perf-ws-data')
const THRESHOLDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'thresholds.json'), 'utf8'))

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const SHOW = argv.includes('--show') && !argv.includes('--no-show')
const REPORT_FILE = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : path.join(__dirname, 'last-workspace-run.json')

function flagNumber(flag, envName, fallback) {
  const fromArgv = argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) : NaN
  if (Number.isFinite(fromArgv) && fromArgv > 0) return fromArgv
  const fromEnv = Number(process.env[envName])
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : fallback
}

const ROOTS = Math.min(8, Math.max(1, flagNumber('--roots', 'PERF_WS_ROOTS', 8)))
const CYCLES = Math.min(200, Math.max(1, flagNumber('--cycles', 'PERF_WS_CYCLES', 50)))
const BUDGET = {
  total: flagNumber('--budget', 'PERF_WS_BUDGET_MS', 5 * 60_000),
  serverHealth: 30_000,
  pageLoad: 60_000,
  workbench: 30_000,
  settle: 8_000
}

applyChromiumSwitches()

const harness = createHarness({
  label: 'perf:ws',
  port: PORT,
  proxyPort: PROXY_PORT,
  dataDir: DATA_DIR,
  budget: { serverHealth: BUDGET.serverHealth, pageLoad: BUDGET.pageLoad, workbench: BUDGET.workbench }
})
const log = harness.log

function mib(kilobytes) {
  return Math.round((kilobytes / 1024) * 10) / 10
}

function mibFromBytes(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10
}

/** Server process RSS + Windows handle count. Cross-platform by necessity: the
 *  number this gate cares about is the one that grows when a per-root resource is
 *  never released, and that number lives in the server process, not the renderer. */
function sampleServer(pid) {
  if (!pid) throw new Error('服务子进程不可采样: pid 为空')
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} | Select-Object WorkingSet64, HandleCount | ConvertTo-Json -Compress)`],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 }
      ).trim()
      const parsed = JSON.parse(out)
      return { rssMiB: mib(Number(parsed.WorkingSet64) / 1024), handles: Number(parsed.HandleCount ?? NaN) }
    } catch (error) {
      throw new Error(`采样服务进程失败 (win32): ${error.message}`)
    }
  }
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
  const rssKb = Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1] ?? NaN)
  const handles = fs.readdirSync(`/proc/${pid}/fd`).length
  return { rssMiB: mib(rssKb), handles }
}

/** Forced collection + JS heap in the page, the same way the editor gate reads it:
 *  working set is allocator policy, heap after gc is retention. */
async function collectHeap(webContents, label) {
  try {
    const result = await withTimeout(
      webContents.executeJavaScript(`(() => {
        if (typeof window.gc === 'function') { window.gc(); window.gc() }
        const memory = window.performance && window.performance.memory
        return { collected: typeof window.gc === 'function', usedBytes: memory ? memory.usedJSHeapSize : null }
      })()`),
      30_000,
      `采样 ${label} JS 堆`
    )
    return result ?? { collected: false, usedBytes: null }
  } catch (error) {
    log(`${label} JS 堆采样失败: ${error.message}`)
    return { collected: false, usedBytes: null }
  }
}

/** Renderer working-set sampler over the whole run; peaks answer "what did the
 *  workbench cost at its worst" and the end sample answers "what came back". */
function sampler(webContents) {
  const peak = { renderer: 0, tree: 0 }
  const timeline = []
  const take = async () => {
    let renderer = 0
    let tree = 0
    for (const metric of app.getAppMetrics()) {
      const workingSet = metric.memory?.workingSetSize ?? 0
      tree += workingSet
      if (metric.type === 'Tab') renderer += workingSet
    }
    peak.renderer = Math.max(peak.renderer, renderer)
    peak.tree = Math.max(peak.tree, tree)
    timeline.push({ at: Date.now(), renderer, tree })
    return { renderer, tree }
  }
  let timer = null
  return {
    peak,
    timeline,
    sample: take,
    start: () => {
      if (!timer) timer = setInterval(() => { take().catch(() => undefined) }, 500)
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}

/** A project-shaped directory per root: a package.json plus a few files, enough
 *  for the FileTree and the workspace payload to do real work without pretending
 *  an 8-root session costs nothing. */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-perf-ws-'))
  const roots = []
  const write = (rootDir, file, text) => {
    fs.mkdirSync(path.dirname(path.join(rootDir, file)), { recursive: true })
    fs.writeFileSync(path.join(rootDir, file), text)
  }
  for (let i = 1; i <= ROOTS; i++) {
    const rootDir = path.join(dir, `r${i}`)
    fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ name: `fixture-${i}`, private: true }, null, 2))
    for (let f = 0; f < 6; f++) {
      write(rootDir, `src/module${f}.ts`, `// module ${f} of root ${i}\nexport const n${f} = ${f}\n`)
    }
    write(rootDir, 'README.md', `# fixture root ${i}\n`)
    roots.push(rootDir)
  }
  return { dir, roots, remove: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function environment() {
  return {
    platform: `${os.platform()} ${os.release()}`,
    cpus: os.cpus().length,
    totalMemMiB: Math.round(os.totalmem() / 1024 / 1024),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    windowShown: SHOW,
    budgetMs: BUDGET
  }
}

function writeReport(result) {
  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8')
  } catch (error) {
    log(`无法写入 ${path.relative(REPO, REPORT_FILE)}: ${error.message}`)
  }
}

function reportFailure(failure) {
  const result = {
    when: new Date().toISOString(),
    env: environment(),
    pass: false,
    failure,
    thresholds: THRESHOLDS.workspace
  }
  writeReport(result)
  log('')
  log(`FAIL  ${failure.reason}`)
  log(`workspace gate: FAIL — ${path.relative(REPO, REPORT_FILE)}`)
  return result
}

function check(checks, result) {
  const lines = checks.map((check) => {
    const known = check.value !== null && check.value !== undefined && Number.isFinite(check.value)
    const cmp = check.cmp ?? 'max'
    const ok = known && (cmp === 'max' ? check.value <= check.limit : check.value >= check.limit)
    log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(34)} ${known ? check.value + (check.unit ? ' ' + check.unit : '') : '未测得'} (限 ${check.limit} ${check.unit ?? ''}, ${cmp})`
    )
    return { name: check.name, value: known ? check.value : null, limit: check.limit, unit: check.unit ?? '', cmp: check.cmp ?? 'max', ok }
  })
  result.gate = lines
  result.pass = lines.every((entry) => entry.ok)
  return result
}

function settle(ms = 600) {
  return delay(ms)
}

async function run() {
  const build = requireBuild()
  const fixture = makeFixture()
  const memory = sampler(null)

  harness.startServer(build)
  await harness.waitForHealth()
  await harness.seedSession()

  const window = harness.createWindow({ show: SHOW, width: 1280, height: 840 })
  const webContents = window.webContents
  await harness.loadApp(window)
  await harness.waitForWorkbench(webContents)
  memory.start()

  const pid = harness.serverPid()
  const server = { atRoots: [], churn: {}, pid }
  const renderer = { peakMiB: null, jsHeapBaselineMiB: null, jsHeapEndMiB: null, jsHeapRetainedMiB: null }

  try {
    // --- baseline: empty workspace (root 1 is added as primary below) ---
    await settle(BUDGET.settle)
    const baseServer = sampleServer(pid)
    const baseHeap = await collectHeap(webContents, '空工作台')
    renderer.jsHeapBaselineMiB = baseHeap.usedBytes === null ? null : mibFromBytes(baseHeap.usedBytes)
    log(`基线: server ${baseServer.rssMiB} MiB · renderer jsHeap ${renderer.jsHeapBaselineMiB} MiB`)

    // --- scale: 1 / 4 / 8 roots open, only the primary is active ---
    for (let i = 0; i < ROOTS; i++) {
      const payload = await harness.addRoot(fixture.roots[i], i === 0)
      if (i === 0 || i === 3 || i === ROOTS - 1) {
        await settle(800)
        server.atRoots.push({ roots: i + 1, ...sampleServer(pid) })
        log(`打开 ${i + 1} 根: server ${server.atRoots[server.atRoots.length - 1].rssMiB} MiB · handles ${server.atRoots[server.atRoots.length - 1].handles}`)
      }
    }
    const runtime = await harness.request('GET', '/api/workspace/runtime')
    const snapshot = runtime
    server.snapshot = {
      roots: snapshot.roots?.length ?? 0,
      activeRootId: snapshot.activeRootId ?? null,
      capacity: snapshot.capacity ?? 0,
      running: snapshot.running ?? 0,
      queued: snapshot.queued ?? false,
      closedLog: snapshot.closedLog?.length ?? 0
    }
    log(`runtime 快照: roots=${server.snapshot.roots} capacity=${server.snapshot.capacity} running=${server.snapshot.running} queued=${server.snapshot.queued}`)

    // --- churn: remove and re-add the last fixture root CYCLES times. The
    // workspace already holds 8 roots, so a scratch root cannot be a 9th; churning
    // one fixture root between 7 and 8 exercises the same add/remove lifecycle
    // (state entry, store row, close log) without hitting MAX_WORKSPACE_ROOTS. ---
    const churnRoot = fixture.roots[fixture.roots.length - 1]
    server.churn.start = sampleServer(pid)
    for (let i = 0; i < CYCLES; i++) {
      const added = await harness.addRoot(churnRoot, false)
      await harness.request('POST', '/api/workspace/roots/remove', { id: added.root.id })
      if (i === Math.floor(CYCLES / 2)) {
        server.churn.mid = sampleServer(pid)
      }
    }
    // Leave the workspace back at 8 roots, as the scaling phase measured it.
    const restored = await harness.addRoot(churnRoot, false)
    server.churn.restoredRootId = restored.root.id
    await settle(1_000)
    server.churn.end = sampleServer(pid)

    // --- retained: what did the renderer keep after all of it ---
    const endHeap = await collectHeap(webContents, '循环结束后')
    renderer.jsHeapEndMiB = endHeap.usedBytes === null ? null : mibFromBytes(endHeap.usedBytes)
    renderer.jsHeapRetainedMiB =
      renderer.jsHeapBaselineMiB !== null && renderer.jsHeapEndMiB !== null
        ? Math.round((renderer.jsHeapEndMiB - renderer.jsHeapBaselineMiB) * 10) / 10
        : null
    renderer.peakMiB = mib(memory.peak.renderer)
  } finally {
    memory.stop()
    if (window && !window.isDestroyed()) window.destroy()
  }

  const gate = THRESHOLDS.workspace?.gate ?? {}
  const g = (name, fallback) => (typeof gate[name] === 'number' ? gate[name] : fallback)
  const rssAt8 = server.atRoots[server.atRoots.length - 1]?.rssMiB ?? 0
  const rssAt1 = server.atRoots[0]?.rssMiB ?? 0
  const churnStart = server.churn.start?.rssMiB ?? 0
  const churnEnd = server.churn.end?.rssMiB ?? 0
  const churnDelta = Math.round((churnEnd - churnStart) * 10) / 10
  const churnGrowthPct = churnStart > 0 ? Math.round(((churnEnd - churnStart) / churnStart) * 1_000) / 10 : null
  const handleDelta = (server.churn.end?.handles ?? 0) - (server.churn.start?.handles ?? 0)

  const metrics = {
    server: { baselineMiB: server.churn.start?.rssMiB ?? null, atRoots: server.atRoots, snapshot: server.snapshot },
    perRootServerMiB: ROOTS > 1 ? Math.round(((rssAt8 - rssAt1) / (ROOTS - 1)) * 10) / 10 : 0,
    churn: {
      startMiB: churnStart,
      midMiB: server.churn.mid?.rssMiB ?? null,
      endMiB: churnEnd,
      deltaMiB: churnDelta,
      growthPct: churnGrowthPct,
      startHandles: server.churn.start?.handles ?? null,
      endHandles: server.churn.end?.handles ?? null,
      handleDelta
    },
    renderer: { peakMiB: renderer.peakMiB, jsHeapRetainedMiB: renderer.jsHeapRetainedMiB }
  }

  const result = check(
    [
      { name: 'server peak across 8 roots', value: rssAt8, limit: g('maxServerRssMiB', 700), unit: 'MiB' },
      { name: 'server per additional root', value: metrics.perRootServerMiB, limit: g('perRootServerMiB', 16), unit: 'MiB' },
      { name: 'churn retained on server', value: churnDelta, limit: g('churnRetainedMiB', 40), unit: 'MiB' },
      { name: 'churn growth %', value: churnGrowthPct, limit: g('churnGrowthPct', 10), unit: '%' },
      { name: 'churn handles retained', value: handleDelta, limit: g('handleRetained', 200), unit: '' },
      { name: 'pool running <= capacity', value: server.snapshot?.running ?? 0, limit: server.snapshot?.capacity ?? 0, unit: '', cmp: 'max' },
      { name: 'renderer peak working set', value: renderer.peakMiB, limit: g('maxRendererMiB', 420), unit: 'MiB' },
      { name: 'renderer JS heap retained', value: renderer.jsHeapRetainedMiB, limit: g('jsHeapRetainedMiB', 12), unit: 'MiB' }
    ],
    { when: new Date().toISOString(), env: environment(), fixture: { roots: ROOTS, cycles: CYCLES }, metrics, thresholds: THRESHOLDS.workspace }
  )

  writeReport(result)
  log('')
  log(`roots ${ROOTS} · cycles ${CYCLES} · server baseline ${churnStart} MiB → 8 根 ${rssAt8} MiB → churn 后 ${churnEnd} MiB (retained ${churnDelta} MiB, ${churnGrowthPct}%)`)
  log(`renderer peak ${renderer.peakMiB} MiB · jsHeap retained ${renderer.jsHeapRetainedMiB} MiB · pool ${server.snapshot?.running ?? 0}/${server.snapshot?.capacity ?? 0}`)
  log(`workspace gate: ${result.pass ? 'PASS' : 'FAIL'} — ${path.relative(REPO, REPORT_FILE)}`)
  return result.pass ? 0 : 1
}

let cleanupPromise = null
function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = harness
      .cleanup({ keepData: KEEP })
      .catch((error) => log(`清理失败: ${error && error.message ? error.message : String(error)}`))
  }
  return cleanupPromise
}

app.whenReady().then(async () => {
  let code = 1
  const watchdog = delay(BUDGET.total).then(() => {
    reportFailure({ reason: `总时限 ${Math.round(BUDGET.total / 1000)}s 用尽,门槛自行终止`, timedOut: true })
    return 1
  })
  try {
    const running = run()
    running.catch(() => undefined)
    code = await Promise.race([running, watchdog])
  } catch (error) {
    reportFailure({ reason: error instanceof Error ? (error.stack ?? error.message) : String(error) })
  } finally {
    await cleanup()
  }
  app.exit(code)
})

app.on('window-all-closed', () => {
  cleanup().catch((error) => log(`清理失败: ${error.message}`))
})
