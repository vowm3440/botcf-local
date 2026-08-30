'use strict'

/** Editor load measurement: eight ~1 MB files open as dirty tabs, in the real app.
 *
 *  P2-004 was closed on architecture (only the front tab keeps a mounted viewer) but
 *  never re-measured, so the performance symptom it was filed for — 714–904 ms per
 *  keystroke, a 1.45 GiB peak that did not come back after closing the tabs — had no
 *  number to compare against and no threshold to fail. This is that number and that
 *  threshold: it starts the same server the desktop shell starts, opens the same page
 *  in the same kind of window, drives the real components (perf/driver.js), samples
 *  the process tree while it does, and exits non-zero when a run is worse than
 *  perf/thresholds.json allows.
 *
 *  Two loads, measured apart. The first is the editor one above. The second is the
 *  内联 diff view, which nothing here could reach until the harness learned to deliver
 *  a finished turn's `files_changed` over the real chat stream — that view only exists
 *  for a file an agent changed, and no agent runs in a gate whose updater points at a
 *  dead proxy. Their memory is attributed separately (`loadDeltaMiB` against
 *  `inlineDeltaMiB`) rather than folded into one peak, because "what eight big dirty
 *  tabs cost" and "what a 3,000-row diff view costs" are two different claims and a
 *  single number would let either of them hide the other's regression.
 *
 *  The gate is itself time-boxed. Two earlier runs sat at "driving the editor…"
 *  indefinitely — no result file, no diagnosis, killed from outside — because the
 *  renderer waited on a frame callback that never came and nothing above it had a
 *  deadline. Now every await here has a ceiling, the whole run has one under any
 *  plausible CI job timeout, and the failure path writes the same structured report
 *  the success path does, with the stage it died in. A measurement harness that can
 *  hang cannot prove anything.
 *
 *  Run with `npm run perf:editor` (builds first). Everything it writes lives in the
 *  OS temp directory: a scratch data directory and the fixture, both removed on the
 *  way out unless `--keep` is passed. The user's own data directory, workspace and
 *  port are never touched.
 *
 *  Flags: --keep (leave fixture + scratch data), --json <file> (where to write the
 *  run; default perf/last-run.json), --show / --no-show (window visibility),
 *  --budget <ms> (total run ceiling; also PERF_BUDGET_MS). */

const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fixture = require('./fixture.cjs')
const { REPO, applyChromiumSwitches, createHarness, delay, requireBuild, withTimeout } = require('../harness/app.cjs')

const PORT = Number(process.env.PERF_PORT ?? 7799)
const PROXY_PORT = Number(process.env.PERF_PROXY_PORT ?? 7798)
const DATA_DIR = path.join(os.tmpdir(), 'botcf-perf-data')
const THRESHOLDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'thresholds.json'), 'utf8'))

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const SHOW = !argv.includes('--no-show')
/** Diagnostic mode: collect at every stage boundary before reading the heap.
 *
 *  The four memory limits here are coarse because committed heap is what V8 happened
 *  to have asked the OS for, and five runs of unchanged code put the same phase at
 *  59.7 and 101.8 MiB. Collecting first turns the stage marks into live-data figures,
 *  which is what you want when attributing allocation to a phase — at the price of a
 *  major GC between phases, so the numbers are not comparable to a default run. Two
 *  runs, not one: that is the answer to "how do you get both". */
const GC_MARKS = argv.includes('--gc-marks')
const REPORT_FILE = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : path.join(__dirname, 'last-run.json')

function flagNumber(flag, envName, fallback) {
  const fromArgv = argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) : NaN
  if (Number.isFinite(fromArgv) && fromArgv > 0) return fromArgv
  const fromEnv = Number(process.env[envName])
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : fallback
}

/** Ceilings. The total must stay comfortably under any CI job timeout, and each
 *  step's own ceiling exists so a failure names the step instead of the run. */
const BUDGET = {
  total: flagNumber('--budget', 'PERF_BUDGET_MS', 8 * 60_000),
  serverHealth: 30_000,
  pageLoad: 60_000,
  /** Waiting for the empty workbench to mount, then letting it go quiet, before the
   *  baseline memory sample. */
  baseline: 30_000,
  baselineSettle: 3_000,
  /** Renderer-side ceiling for the whole drive; the main process allows a little
   *  more so the driver's own structured failure wins the race and gets reported. */
  drive: 5 * 60_000,
  driveSlack: 20_000,
  frame: 5_000,
  /** The window the original measurement used to see what the renderer gives back. */
  settle: 10_000,
  /** And then a second wait, after the forced collection — see the sampling order in
   *  `run()`. Collecting is not releasing. */
  releaseSettle: 3_000
}

applyChromiumSwitches()

const harness = createHarness({
  label: 'perf',
  port: PORT,
  proxyPort: PROXY_PORT,
  dataDir: DATA_DIR,
  budget: { serverHealth: BUDGET.serverHealth, pageLoad: BUDGET.pageLoad, workbench: BUDGET.baseline }
})
const log = harness.log

/** Last stage the driver reported, for a failure that never returns a value. */
let stageLog = { last: () => ({ stage: 'not-started', elapsedMs: 0 }), at: () => null, stages: [] }

function mib(kilobytes) {
  return Math.round((kilobytes / 1024) * 10) / 10
}

function mibFromBytes(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10
}

/** A forced collection, and the JS heap after it.
 *
 *  Working set is not a retention measurement. V8 and PartitionAlloc hold on to
 *  freed pages instead of returning them to the OS, and nothing in a ten second
 *  idle window makes them change their mind — so a "did the memory come back"
 *  check that samples the working set is reading the allocator's release policy,
 *  not the application's retention. Collecting first is what makes the sample
 *  after it mean "this is what is still reachable".
 *
 *  Done in the page, through `--expose-gc` and `performance.memory`, rather than
 *  over CDP. The first version of this attached a debugger, and attaching one is
 *  not free: after `Memory.forciblyPurgeJavaScriptMemory` and a detach, the very
 *  next `executeJavaScript` never returned and the run died at its 30 s ceiling
 *  having measured nothing at all. A tool that can wedge the thing it measures is
 *  not a measurement tool. This way there is also no debugger attached anywhere
 *  near the keystrokes, which a latency number must not be measured through.
 *
 *  `usedBytes` is null when the page cannot answer; the gate treats that as a
 *  failed check rather than a skipped one. */
async function collectAndMeasureHeap(webContents, label) {
  try {
    const result = await withTimeout(
      webContents.executeJavaScript(`(() => {
        const canCollect = typeof window.gc === 'function'
        // Twice: the first pass can leave objects that only become collectible
        // once the finalizers it ran have been processed.
        if (canCollect) { window.gc(); window.gc() }
        const memory = window.performance && window.performance.memory
        return { collected: canCollect, usedBytes: memory ? memory.usedJSHeapSize : null }
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

/** Samples the process tree while the page is driven, the way the original report
 *  did: working set per process type, plus the renderer's private bytes.
 *
 *  Keeps every sample, not only the maximum, because the run now carries two loads
 *  and a single peak cannot say which of them it came from. With the timeline plus
 *  the driver's stage timestamps, "what the eight tabs cost" and "what the inline
 *  view cost" are separate answers instead of one number that quietly reports the
 *  larger of the two.
 *
 *  Started explicitly rather than on construction, so the baseline sample can be
 *  taken against an idle empty workbench before the drive begins. */
function sampler(webContents) {
  const peak = { renderer: 0, rendererPrivate: 0, tree: 0 }
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
    let priv = 0
    try {
      const info = await webContents.getProcessMemoryInfo()
      priv = info.private ?? 0
    } catch {
      // The renderer may be mid-navigation; the next sample covers it.
    }
    peak.rendererPrivate = Math.max(peak.rendererPrivate, priv)
    return { renderer, tree, private: priv }
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

/** Highest renderer working set sampled inside a wall-clock window, or null when the
 *  window never contained a sample. Null rather than zero: a phase nobody sampled has
 *  no peak, and reporting one as 0 would read as "it cost nothing". */
function peakBetween(timeline, from, to) {
  if (from === null) return null
  let peak = null
  for (const sample of timeline) {
    if (sample.at < from) continue
    if (to !== null && sample.at > to) continue
    peak = Math.max(peak ?? 0, sample.renderer)
  }
  return peak
}

/** The largest JS heap the run ever had committed, from the driver's stage marks.
 *
 *  This is the number that explains `retainedDelta`, and the one that moves when the
 *  application's allocation behaviour changes. Committed is deliberately not `used`:
 *  used is what survives a collection, committed is what V8 asked the OS for — and
 *  V8 does not hand those pages back promptly, GC or no GC, idle or not. So the
 *  working set after closing everything is mostly this, and gating on it catches the
 *  cause where gating on the working set only catches the symptom through a layer of
 *  allocator policy. */
function heapCommittedPeak(marks) {
  if (!marks) return null
  let peak = null
  for (const mark of Object.values(marks)) {
    if (mark && typeof mark.totalMiB === 'number') peak = Math.max(peak ?? 0, mark.totalMiB)
  }
  return peak
}

/** What the run has to beat.
 *
 *  The memory checks are stated as deltas over an idle empty workbench, and that is
 *  a correction, not a relaxation. The previous pair — `renderer after close ≤ 450`
 *  and `released after close ≥ 80` — were both written as if they described the
 *  editor load, but sampling only started once the page was already up, so they were
 *  really being applied to `workbench + load`. The second was worse than imprecise:
 *  it demanded that closing the tabs give back 80 MiB, while the P2-004 fix means
 *  the eight tabs never take that much in the first place. A check that can only be
 *  passed by first wasting the memory it then asks you to return cannot survive the
 *  fix it was written for. `loadDelta` asks how much the tabs cost, `retainedDelta`
 *  asks how much of it survives closing them, and `jsHeapRetained` — measured after a
 *  real collection — is the one that actually detects a leak.
 *
 *  Latency is judged on `inputPaint`, not `inputFrame`: a rAF callback runs before
 *  the frame's layout and paint, so moving work past it would have shown up as a
 *  win that nobody could see. Both are reported.
 *
 *  Opening a tab is judged twice, because it is two different costs. The first open
 *  also fetches the lazily loaded editor chunk; every later one does not. Judged as a
 *  single p95 over eight samples, the p95 *is* the first one, so a one-time cost read
 *  as a per-tab regression — which is exactly the confusion that nearly reverted the
 *  code split (docs/perf-gate-2026-08-28.md §9 #4). Separated, each line means one
 *  thing and either can fail on its own.
 *
 *  The inline pair is a structural invariant, not a timing: `rowsMounted` is what the
 *  view keeps in the DOM and `rowsTotal` is what it models. Gating the first alone
 *  would pass a fixture that accidentally produced no rows, so the second is a floor —
 *  the only lower bound here, and it is there so the invariant cannot pass vacuously. */
function checkGate(drive, memory) {
  const limits = THRESHOLDS.gate
  const inline = drive.inline ?? {}
  const checks = [
    { name: 'mounted viewers with 8 tabs', value: drive.viewersWithEightTabs, limit: limits.maxMountedViewers, unit: '' },
    { name: 'input → painted P95', value: drive.inputPaint.p95, limit: limits.inputPaintP95Ms, unit: 'ms' },
    { name: 'input → painted max', value: drive.inputPaint.max, limit: limits.inputPaintMaxMs, unit: 'ms' },
    { name: 'open first tab', value: drive.openFirst, limit: limits.openFirstMs, unit: 'ms' },
    { name: 'open per tab P95 (steady)', value: drive.openSteady.p95, limit: limits.openSteadyP95Ms, unit: 'ms' },
    { name: 'tab switch P95', value: drive.tabSwitch.p95, limit: limits.tabSwitchP95Ms, unit: 'ms' },
    { name: 'inline rows modelled', value: inline.rowsTotal, limit: limits.inlineRowsTotalMin, unit: '', cmp: 'min' },
    { name: 'inline rows in the DOM', value: inline.rowsMountedPeak, limit: limits.inlineRowsMountedMax, unit: '' },
    { name: 'inline expanded rows modelled', value: inline.fullRowsTotal, limit: limits.inlineFullRowsTotalMin, unit: '', cmp: 'min' },
    { name: 'inline expanded rows in the DOM', value: inline.fullRowsMountedPeak, limit: limits.inlineFullRowsMountedMax, unit: '' },
    { name: 'inline → painted', value: inline.showMs === null ? null : Math.round(inline.showMs * 100) / 100, limit: limits.inlineShowMs, unit: 'ms' },
    { name: 'inline scroll P95', value: inline.scroll?.p95 ?? null, limit: limits.inlineScrollP95Ms, unit: 'ms' },
    { name: 'renderer peak working set', value: memory.rendererPeakMiB, limit: limits.rendererPeakMiB, unit: 'MiB' },
    { name: 'load over empty workbench', value: memory.loadDeltaMiB, limit: limits.loadDeltaMiB, unit: 'MiB' },
    { name: 'inline load over empty workbench', value: memory.inlineDeltaMiB, limit: limits.inlineDeltaMiB, unit: 'MiB' },
    { name: 'JS heap committed peak', value: memory.jsHeapCommittedPeakMiB, limit: limits.jsHeapCommittedPeakMiB, unit: 'MiB' },
    { name: 'retained after close', value: memory.retainedDeltaMiB, limit: limits.retainedDeltaMiB, unit: 'MiB' },
    { name: 'JS heap retained after close', value: memory.jsHeapRetainedMiB, limit: limits.jsHeapRetainedMiB, unit: 'MiB' }
  ]
  return checks.map((check) => {
    const known = check.value !== null && check.value !== undefined
    return {
      name: check.name,
      value: check.value,
      limit: check.limit,
      unit: check.unit,
      cmp: check.cmp ?? 'max',
      ok: known && (check.cmp === 'min' ? check.value >= check.limit : check.value <= check.limit)
    }
  })
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
    gcMarks: GC_MARKS,
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

/** The failure half of the report. Written for every non-pass outcome, including
 *  the watchdog, so "the gate hung" is never again a run with nothing to read. */
function reportFailure(failure) {
  const lastStage = stageLog.last()
  const result = {
    when: new Date().toISOString(),
    env: environment(),
    pass: false,
    failure: { ...failure, lastStage },
    baseline: THRESHOLDS.baseline
  }
  writeReport(result)
  log('')
  log(`FAIL  ${failure.reason}`)
  log(`阶段: ${lastStage.stage}${failure.diagnostics ? ` · ${JSON.stringify(failure.diagnostics)}` : ''}`)
  if (failure.partial) log(`已测得: ${JSON.stringify(failure.partial)}`)
  log(`editor load gate: FAIL — ${path.relative(REPO, REPORT_FILE)}`)
  return result
}

/** Labels for the keystroke breakdown. Which of these appear depends on how the
 *  driver typed — see `typeMeasured` in driver.js. */
const PART_LABELS = {
  browserEdit: '编辑器编辑',
  react: 'React'
}

const HEAP_MARK_LABELS = [
  ['beforeOpen', '开标签前'],
  ['afterOpen', '开完'],
  ['afterTyping', '打完字'],
  ['afterSwitching', '切完标签'],
  ['afterClose', '全关后'],
  ['afterDeliver', '收到差异'],
  ['afterInline', '内联滚完'],
  ['afterInlineFull', '展开滚完'],
  ['afterInlineClose', '内联关掉后']
]

function report(result) {
  const width = Math.max(...result.gate.map((check) => check.name.length))
  const drive = result.drive
  const memory = result.memory
  log('')
  log(`load: ${result.fixture.files.length} files × ${result.fixture.lines} lines × ${result.fixture.bytesPerFile} B, all dirty`)
  log(`open first     ${drive.openFirst} ms(含编辑器 chunk)· 之后 p50 ${drive.openSteady.p50} ms · p95 ${drive.openSteady.p95} ms`)
  log(`keystroke block p50 ${drive.inputBlock.p50} ms · p95 ${drive.inputBlock.p95} ms`)
  // Which part of the keystroke the time went into. Only `react` is the
  // application's; the rest is what the browser charges for a buffer this size.
  const parts = Object.entries(drive.inputBreakdown ?? {})
  parts.forEach(([name, stat], index) => {
    const branch = index === parts.length - 1 ? '└' : '├'
    log(`  ${branch} ${(PART_LABELS[name] ?? name).padEnd(10)} p50 ${stat.p50} ms · p95 ${stat.p95} ms`)
  })
  // Both frame numbers, because they answer different questions and the gap
  // between them is exactly the layout and paint a rAF callback does not wait for.
  log(`input → rAF     p50 ${drive.inputFrame.p50} ms · p95 ${drive.inputFrame.p95} ms`)
  log(`input → painted p50 ${drive.inputPaint.p50} ms · p95 ${drive.inputPaint.p95} ms`)
  // The pair that settles whether keeping the forced layout out of the keystroke path
  // buys anything at the rate it was supposed to: several edits inside one frame.
  const burst = drive.burst
  if (burst && burst.paint.samples > 0) {
    log(`连打 ${burst.size} 键 → 上屏   ${burst.paint.p50} ms · 每键 ${Math.round((burst.paint.p50 / burst.size) * 10) / 10} ms`)
    log(`  同样但每键强制布局  ${burst.paintWithForcedLayout.p50} ms · 每键 ${Math.round((burst.paintWithForcedLayout.p50 / burst.size) * 10) / 10} ms`)
  }
  // The windowing claim, as two numbers rather than an argument: what the view
  // models against what it actually puts in the document.
  const inline = drive.inline
  if (inline && inline.rowsTotal !== null) {
    const ratio = (total, mounted) => (mounted > 0 ? `${Math.round((total / mounted) * 10) / 10}×` : '—')
    log('')
    log(`内联差异  ${inline.rowsTotal} 行建模 · DOM 里最多 ${inline.rowsMountedPeak} 行(${ratio(inline.rowsTotal, inline.rowsMountedPeak)})`)
    log(`  切到内联 ${Math.round(inline.showMs * 10) / 10} ms · 滚动 p50 ${inline.scroll.p50} ms · p95 ${inline.scroll.p95} ms`)
    if (inline.fullRowsTotal !== null) {
      log(
        `  显示全文  ${inline.fullCollapsedRows} → ${inline.fullRowsTotal} 行建模 · DOM 里最多 ` +
        `${inline.fullRowsMountedPeak} 行(${ratio(inline.fullRowsTotal, inline.fullRowsMountedPeak)})· ` +
        `展开 ${Math.round(inline.fullShowMs * 10) / 10} ms`
      )
    }
  }
  log('')
  // What the working-set peak is made of. A peak that is JS heap is garbage the
  // collector has not reached; a peak that is not is Blink holding structures for
  // the laid-out text, and only one of those is fixed by allocating less.
  const marks = drive.heapMarks
  if (marks && marks.beforeOpen) {
    const steps = HEAP_MARK_LABELS.filter(([key]) => marks[key]).map(
      ([key, label]) => `${label} ${marks[key].usedMiB}/${marks[key].totalMiB}`
    )
    log('JS 堆 已用/已提交 MiB')
    log(`  ${steps.join(' → ')}`)
  }
  log(`renderer  空工作台 ${memory.rendererBaselineMiB} MiB → 编辑器峰值 ${memory.rendererLoadPeakMiB} MiB → 内联峰值 ${memory.rendererInlinePeakMiB} MiB → 关闭后 ${memory.rendererAfterCloseMiB} MiB`)
  log(
    memory.jsHeapRetainedMiB === null
      ? 'JS 堆     不可用(页面未能回答),泄漏检查无法判定'
      : `JS 堆     空工作台 ${memory.jsHeapBaselineMiB} MiB → 关闭并强制回收后 ${memory.jsHeapAfterCloseMiB} MiB`
  )
  log('')
  for (const check of result.gate) {
    const bound = check.cmp === 'min' ? '≥' : '≤'
    log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(width)}  ${check.value}${check.unit} (${bound} ${check.limit}${check.unit})`)
  }
  log('')
  log(result.pass ? 'editor load gate: PASS' : 'editor load gate: FAIL')
  log(`written to ${path.relative(REPO, REPORT_FILE)}`)
}

async function run() {
  const build = requireBuild()
  log('generating fixture…')
  const load = fixture.create()
  log(`fixture at ${load.dir}`)
  const changedFiles = fixture.sessionDiffs()
  log(`session diff ${fixture.DIFF_REGIONS} regions/file · ${Math.round(changedFiles[1].diff.length / 1024)} KiB each`)
  log(`expandable ${load.expandable} · ${load.expandableLines} lines × ${fixture.EXPANDABLE_REGIONS} regions`)
  if (GC_MARKS) log('诊断运行:每个阶段边界先强制回收 —— 内存数字与默认运行不可比')

  harness.startServer(build)
  await withTimeout(harness.waitForHealth(), BUDGET.serverHealth + 5_000, '等待本地服务')
  await withTimeout(harness.seedSession(), 30_000, '建立会话')
  await withTimeout(harness.addRoot(load.dir, true), 30_000, '添加工作区根目录')
  log(`workspace root ${load.rootName} added`)

  let window = null
  let memory = null
  try {
    window = harness.createWindow({ show: SHOW })
    stageLog = harness.trackStages(window.webContents)
    await harness.loadApp(window)

    memory = sampler(window.webContents)

    // What the workbench costs with nothing open. Until this existed, sampling
    // started with the page already up, so every memory limit was applied to
    // `workbench + load` while being written as if it described `load`.
    // Everything the gate judges about memory is a delta from here.
    await withTimeout(harness.waitForWorkbench(window.webContents), BUDGET.baseline + 5_000, '等待空工作台')
    await delay(BUDGET.baselineSettle)
    const baselineHeap = await collectAndMeasureHeap(window.webContents, '基线')
    const baseline = await withTimeout(memory.sample(), 30_000, '采样基线内存')
    log(`baseline renderer ${mib(baseline.renderer)} MiB · JS 堆 ${baselineHeap.usedBytes === null ? '不可用' : `${mibFromBytes(baselineHeap.usedBytes)} MiB`}`)

    memory.start()
    const options = {
      paths: fixture.workspacePaths(),
      expandablePath: fixture.expandablePath(),
      changedFiles,
      inputSamples: 30,
      switchRounds: 3,
      inlineScrollSteps: 12,
      gcMarks: GC_MARKS,
      timeoutMs: 60_000,
      frameTimeoutMs: BUDGET.frame,
      redispatchMs: 1_500,
      totalMs: BUDGET.drive
    }
    await withTimeout(
      window.webContents.executeJavaScript(`window.__PERF__ = ${JSON.stringify(options)}; true`),
      30_000,
      '注入驱动参数'
    )
    // The session-diff delivery, defined before the driver runs so the driver can
    // simply call it. It stubs `fetch` for the chat stream and nothing else.
    await withTimeout(
      window.webContents.executeJavaScript(fs.readFileSync(path.join(REPO, 'harness', 'inject.js'), 'utf8')),
      30_000,
      '注入 harness'
    )
    log('driving the editor…')
    const outcome = await withTimeout(
      window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'driver.js'), 'utf8'), true),
      BUDGET.drive + BUDGET.driveSlack,
      '驱动编辑器'
    )

    if (!outcome || outcome.ok !== true) {
      reportFailure({
        reason: outcome ? `驱动在 ${outcome.stage} 阶段失败: ${outcome.message}` : '驱动没有返回结果',
        timedOut: Boolean(outcome && outcome.timedOut),
        diagnostics: outcome ? outcome.diagnostics : null,
        partial: outcome ? outcome.partial : null
      })
      return 1
    }
    const drive = outcome.report

    // The report's other half: what the renderer gives back once the tabs are gone.
    // Ten seconds is the window the original measurement used — but idling for ten
    // seconds is not a reason for anything to be freed, so a real collection runs
    // first. Without it the sample answers "does the allocator return pages when
    // nobody asks", which is not a question about this editor.
    memory.stop()
    await delay(BUDGET.settle)
    const afterCloseHeap = await collectAndMeasureHeap(window.webContents, '关闭后')
    // Collecting is not releasing, and sampling in the same tick as `gc()` conflated
    // the two. V8 hands pages back to the OS *after* a major GC finishes, not during
    // it, and the working set only moves once it has — so an immediate sample counted
    // the whole of V8's committed heap as "retained", a word that is supposed to mean
    // the application is still holding it. The wait is part of the measurement.
    await delay(BUDGET.releaseSettle)
    const afterClose = await withTimeout(memory.sample(), 30_000, '采样关闭后内存')
    const heapKnown = baselineHeap.usedBytes !== null && afterCloseHeap.usedBytes !== null

    // Two loads, two windows. The editor phases run from the first tab up to the
    // moment the harness starts delivering the diff; the inline phases run from
    // there to the end of the drive.
    const inlineFrom = stageLog.at('inline-open')
    const loadPeak = peakBetween(memory.timeline, stageLog.at('open-tabs'), inlineFrom) ?? memory.peak.renderer
    const inlinePeak = peakBetween(memory.timeline, inlineFrom, null)

    const memoryResult = {
      rendererBaselineMiB: mib(baseline.renderer),
      rendererPeakMiB: mib(memory.peak.renderer),
      rendererLoadPeakMiB: mib(loadPeak),
      rendererInlinePeakMiB: inlinePeak === null ? null : mib(inlinePeak),
      rendererPrivatePeakMiB: mib(memory.peak.rendererPrivate),
      treePeakMiB: mib(memory.peak.tree),
      rendererAfterCloseMiB: mib(afterClose.renderer),
      /** The two numbers P2-004 is actually about: what the eight tabs add over an
       *  empty workbench, and how much of that survives closing them. The absolute
       *  figures above are mostly the workbench. */
      loadDeltaMiB: mib(loadPeak - baseline.renderer),
      /** The same question for the other load, kept separate so neither can hide
       *  the other's regression. */
      inlineDeltaMiB: inlinePeak === null ? null : mib(inlinePeak - baseline.renderer),
      retainedDeltaMiB: mib(afterClose.renderer - baseline.renderer),
      releasedAfterCloseMiB: mib(memory.peak.renderer - afterClose.renderer),
      jsHeapBaselineMiB: baselineHeap.usedBytes === null ? null : mibFromBytes(baselineHeap.usedBytes),
      jsHeapAfterCloseMiB: afterCloseHeap.usedBytes === null ? null : mibFromBytes(afterCloseHeap.usedBytes),
      /** The cause `retainedDelta` is mostly made of — see `heapCommittedPeak`. */
      jsHeapCommittedPeakMiB: heapCommittedPeak(drive.heapMarks),
      /** Measured after a forced collection, so this one is retention rather than
       *  release policy — the only number here that can detect a leak. Null when the
       *  page could not answer, which fails the check rather than passing it
       *  silently: an unmeasured gate is not a passed gate. */
      jsHeapRetainedMiB: heapKnown ? mibFromBytes(afterCloseHeap.usedBytes - baselineHeap.usedBytes) : null,
      collectedBeforeSample: baselineHeap.collected && afterCloseHeap.collected
    }

    const gate = checkGate(drive, memoryResult)
    const result = {
      when: new Date().toISOString(),
      env: environment(),
      fixture: {
        dir: load.dir,
        files: load.files,
        lines: load.lines,
        bytesPerFile: load.bytesPerFile,
        diffRegionsPerFile: fixture.DIFF_REGIONS,
        diffBytesPerFile: changedFiles[1].diff.length,
        expandable: load.expandable,
        expandableLines: load.expandableLines,
        expandableRegions: fixture.EXPANDABLE_REGIONS
      },
      drive,
      memory: memoryResult,
      baseline: THRESHOLDS.baseline,
      gate,
      pass: gate.every((check) => check.ok)
    }

    writeReport(result)
    report(result)
    return result.pass ? 0 : 1
  } finally {
    // Both run on every path, including the throw that used to leave the sampler's
    // interval holding the event loop open.
    if (memory) memory.stop()
    if (window && !window.isDestroyed()) window.destroy()
  }
}

let cleanupPromise = null

/** Idempotent, and it never rejects — see the same function in e2e/editor.cjs. A
 *  removal that throws would escape into `app.whenReady`'s handler and leave
 *  `app.exit` unreached, which is a hung run reported as a passing one.
 *
 *  Server first: it is the process most likely to still hold a handle inside the
 *  fixture, and on Windows that is enough to refuse the directory. */
function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      await harness.cleanup({ keepData: KEEP })
      if (!KEEP) await fixture.remove()
    })().catch((error) => log(`清理失败: ${error && error.message ? error.message : String(error)}`))
  }
  return cleanupPromise
}

app.whenReady().then(async () => {
  let code = 1
  /** The last line of defence: whatever wedges — renderer, Electron, the server
   *  handshake — the gate still ends, with a report that names the stage. */
  const watchdog = delay(BUDGET.total).then(() => {
    reportFailure({
      reason: `总时限 ${Math.round(BUDGET.total / 1000)}s 用尽,门槛自行终止`,
      timedOut: true,
      diagnostics: null,
      partial: null
    })
    return 1
  })
  try {
    const running = run()
    // The race reports whichever finishes first; this only stops a *late*
    // rejection from `run()` (one that lands after the watchdog already won)
    // from surfacing as an unhandled rejection.
    running.catch(() => undefined)
    code = await Promise.race([running, watchdog])
  } catch (error) {
    reportFailure({
      reason: error instanceof Error ? (error.stack ?? error.message) : String(error),
      timedOut: /超时/.test(String(error && error.message)),
      diagnostics: null,
      partial: null
    })
  } finally {
    // Awaited: cleanup now waits for the server to release the data directory,
    // and `app.exit` would cut that short.
    await cleanup()
  }
  app.exit(code)
})

app.on('window-all-closed', () => {
  // The run owns the lifecycle; closing the window early must still tear down.
  cleanup().catch((error) => log(`清理失败: ${error.message}`))
})
