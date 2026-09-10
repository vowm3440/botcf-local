'use strict'

/** Editor E2E: the CodeMirror integration, asserted in a real browser.
 *
 *  `npm run test:e2e`
 *
 *  Three behaviours arrived with the text surface when it stopped being a
 *  `<textarea>` (docs/perf-gate-2026-08-28.md §6) and none of them had a test: the
 *  assistant's edits drawn as line decorations, the change bars in the gutter and
 *  what clicking one does, and the read-only surface a file over 1 MiB gets. The perf
 *  gate drives the same integration but only ever asks how fast it is, and the unit
 *  tests stop at the pure functions on purpose — CodeMirror in jsdom measures every
 *  element as zero pixels, so its viewport logic degrades and a component test there
 *  passes without testing the component. On its first run this suite found a
 *  data-loss bug the gate had been driving past at full speed for weeks.
 *
 *  It also covers the two panels that hand files *to* the editor — the Git panel and
 *  the diagnostics centre — because both have an honest source of state (a git
 *  repository on disk; the endpoint the sandboxed preview page posts runtime errors
 *  to) and both end at the same cross-panel signal the editor listens for. Review
 *  uses a local RPC runtime fixture to reach the server's real turn-recording path;
 *  terminal checks exercise real shell history and session closure.
 *
 *  What was missing was not a different assertion library, it was a real browser. So
 *  this reuses the gate's own bootstrap (harness/app.cjs): the same build, the same
 *  server on a scratch port and data directory, the same kind of Electron window on
 *  the same page. The difference is what it does with it — e2e/spec.js asserts rather
 *  than measures, and the run passes only when every check does.
 *
 *  Editor diffs come as `files_changed` over the real chat stream, with the upstream
 *  faked in the renderer (harness/inject.js). The review check instead sends a turn
 *  through the server and the local OMP fixture. No remote model is contacted.
 *
 *  Flags: --keep (leave the fixture and scratch data), --json <file> (default
 *  e2e/last-run.json), --show / --no-show, --budget <ms> (also E2E_BUDGET_MS). */

const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fixture = require('./fixture.cjs')
const { buildSessionDiff, changedFile, countEdits } = require('../harness/sessionDiff.cjs')
const { REPO, applyChromiumSwitches, createHarness, delay, requireBuild, withTimeout } = require('../harness/app.cjs')

const PORT = Number(process.env.E2E_PORT ?? 7797)
const PROXY_PORT = Number(process.env.E2E_PROXY_PORT ?? 7796)
const DATA_DIR = path.join(os.tmpdir(), 'botcf-e2e-data')

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const SHOW = !argv.includes('--no-show')
const REPORT_FILE = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : path.join(__dirname, 'last-run.json')

function flagNumber(flag, envName, fallback) {
  const fromArgv = argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) : NaN
  if (Number.isFinite(fromArgv) && fromArgv > 0) return fromArgv
  const fromEnv = Number(process.env[envName])
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : fallback
}

/** Same reasoning as the gate's: every wait has a ceiling and the run has one, so a
 *  wedged renderer ends as a report that names the check it died on rather than as a
 *  job somebody kills by hand. */
const BUDGET = {
  total: flagNumber('--budget', 'E2E_BUDGET_MS', 4 * 60_000),
  serverHealth: 30_000,
  pageLoad: 60_000,
  workbench: 30_000,
  spec: 2 * 60_000,
  specSlack: 20_000
}

applyChromiumSwitches()

const harness = createHarness({
  label: 'e2e',
  port: PORT,
  proxyPort: PROXY_PORT,
  dataDir: DATA_DIR,
  budget: { serverHealth: BUDGET.serverHealth, pageLoad: BUDGET.pageLoad, workbench: BUDGET.workbench }
})
const log = harness.log

let stageLog = { last: () => ({ stage: 'not-started' }), at: () => null, stages: [] }

function writeReport(result) {
  try {
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true })
    fs.writeFileSync(REPORT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8')
    log(`written to ${path.relative(REPO, REPORT_FILE)}`)
    return true
  } catch (error) {
    log(`无法写入 ${path.relative(REPO, REPORT_FILE)}: ${error.message}`)
    return false
  }
}

function environment() {
  return {
    platform: `${os.platform()} ${os.release()}`,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    windowShown: SHOW,
    budgetMs: BUDGET
  }
}

function report(result) {
  log('')
  for (const check of result.checks) {
    if (check.ok === true) log(`PASS  ${check.name}${check.ms === undefined ? '' : `  (${check.ms} ms)`}`)
    else if (check.ok === false) log(`FAIL  ${check.name}\n      ${check.message}`)
    else log(`SKIP  ${check.name}  ${check.skipped ?? ''}`)
  }
  if (result.fatal) log(`\n驱动异常: ${result.fatal}`)
  log('')
  const passed = result.checks.filter((check) => check.ok === true).length
  log(`editor e2e: ${result.pass ? 'PASS' : 'FAIL'} — ${passed}/${result.checks.length} 项通过`)
}

/** The load, and what the app is expected to make of it.
 *
 *  Both come out of the same descriptors: the diff is generated from `EDITS` and the
 *  numbers the assertions compare against are counted from `EDITS`. An assertion that
 *  hard-coded 「3 处」 would keep passing after the fixture changed under it. */
function buildLoad(load) {
  const lines = load.editedLines
  const diff = buildSessionDiff(load.editedPath, lines, fixture.EDITS)
  const totals = countEdits(fixture.EDITS)
  const at = (line) => ({ line, text: lines[line - 1] })
  const deletion = fixture.EDITS.find((edit) => edit.kind === 'delete')
  return {
    changedFiles: [changedFile(load.editedPath, diff)],
    expected: {
      ...totals,
      add: at(fixture.EDITS.find((edit) => edit.kind === 'add').line),
      modify: at(fixture.EDITS.find((edit) => edit.kind === 'modify').line),
      delete: at(deletion.line),
      removedText: deletion.removed
    }
  }
}

/** Put a stub agent runtime behind the server, so the checks that need a *real* turn
 *  can have one.
 *
 *  `OMP_COMMAND` is the array form on purpose: `spawn` on Windows needs a real
 *  executable, so a JavaScript stub cannot be reached by a path alone. The plan file
 *  lives outside the workspace root — inside it, git would report it as untracked and
 *  the Git panel checks would be looking at a different working tree than the fixture
 *  set up. */
function stubRuntime(load, changedFiles) {
  const planFile = path.join(os.tmpdir(), 'botcf-e2e-omp-plan.json')
  const plan = {
    text: '已经按要求改好了。',
    files: changedFiles.map((file) => ({ path: file.path, diff: file.diff, tool: 'edit_file' }))
  }
  fs.writeFileSync(planFile, JSON.stringify(plan), 'utf8')
  return {
    planFile,
    env: {
      OMP_COMMAND: JSON.stringify([process.platform === 'win32' ? 'node.exe' : 'node', path.join(REPO, 'harness', 'ompStub.cjs')]),
      OMP_STUB_PLAN: planFile,
      OMP_STUB_SESSION: path.join(load.dir, '..', 'botcf-e2e-session.jsonl')
    }
  }
}

async function run() {
  const build = requireBuild()
  const load = await fixture.create()
  log(`fixture at ${load.dir}`)
  const { changedFiles, expected } = buildLoad(load)
  log(`session diff ${expected.regions} regions · +${expected.added} −${expected.removed}`)
  log(load.gitReady ? `git repo ready · ${load.trackedFile} modified` : 'git 不可用 —— Git 面板的检查会判失败')
  const stub = stubRuntime(load, changedFiles)
  log('stub agent runtime behind the server (harness/ompStub.cjs)')

  harness.startServer(build, stub.env)
  await withTimeout(harness.waitForHealth(), BUDGET.serverHealth + 5_000, '等待本地服务')
  await withTimeout(harness.seedSession(), 30_000, '建立会话')
  await withTimeout(harness.addRoot(load.dir, true), 30_000, '添加工作区根目录')
  log(`workspace root ${load.rootName} added`)

  let window = null
  try {
    window = harness.createWindow({ show: SHOW })
    stageLog = harness.trackStages(window.webContents)
    await harness.loadApp(window)
    await withTimeout(harness.waitForWorkbench(window.webContents), BUDGET.workbench + 5_000, '等待空工作台')

    const options = {
      editedPath: load.editedPath,
      oversizedPath: load.oversizedPath,
      trackedFile: load.trackedFile,
      gitReady: load.gitReady,
      expandedOnlyLine: fixture.LINE_ONLY_VISIBLE_WHEN_EXPANDED,
      diagnosticMessage: `e2e runtime error ${Date.now()}`,
      commitMessage: `e2e commit ${Date.now()}`,
      changedFiles,
      expected,
      timeoutMs: 30_000
    }
    await withTimeout(
      window.webContents.executeJavaScript(`window.__E2E__ = ${JSON.stringify(options)}; true`),
      30_000,
      '注入参数'
    )
    await withTimeout(
      window.webContents.executeJavaScript(fs.readFileSync(path.join(REPO, 'harness', 'inject.js'), 'utf8')),
      30_000,
      '注入 harness'
    )
    log('running editor checks…')
    const outcome = await withTimeout(
      window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'spec.js'), 'utf8'), true),
      BUDGET.spec + BUDGET.specSlack,
      '执行检查'
    )

    const checks = outcome?.checks ?? []
    const result = {
      when: new Date().toISOString(),
      env: environment(),
      fixture: { dir: load.dir, files: load.files, edited: load.editedPath, oversized: load.oversizedPath, tracked: load.trackedPath, gitReady: load.gitReady },
      expected,
      checks,
      ...(outcome?.fatal ? { fatal: outcome.fatal, diagnostics: outcome.diagnostics ?? null } : {}),
      // An empty check list is a failed run, not a vacuous pass: a spec that never
      // ran has proved nothing.
      pass: checks.length > 0 && checks.every((check) => check.ok === true)
    }
    const written = writeReport(result)
    report(result)
    return result.pass && written ? 0 : 1
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
  }
}

let cleanupPromise = null

/** Idempotent, and it never rejects.
 *
 *  Both matter, and the second one is a fix: `fixture.remove()` came back EPERM on the
 *  git repository it had just written, the rejection escaped this function, and
 *  `app.exit` below never ran — the run had to be killed by hand after reporting a
 *  perfectly good 15/15. A harness that can hang cannot prove anything, and that
 *  applies to the tidying up as much as to the driving.
 *
 *  The server goes first: it is the process most likely to still hold a handle inside
 *  the fixture, and on Windows a directory with a live handle in it refuses to go. */
function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      await harness.cleanup({ keepData: KEEP })
      if (KEEP) return
      // Reported, not swallowed. A removal that fails silently is why a run once
      // announced a clean teardown and left the git repository behind for the next
      // one to die on.
      const gone = await fixture.remove((error) => log(`夹具目录未能删除: ${error.message}`))
      if (!gone) log(`夹具目录仍在,下次运行前需要手动删除: ${fixture.fixtureDir()}`)
    })().catch((error) => log(`清理失败: ${error && error.message ? error.message : String(error)}`))
  }
  return cleanupPromise
}

app.whenReady().then(async () => {
  let code = 1
  const watchdog = delay(BUDGET.total).then(() => {
    const result = {
      when: new Date().toISOString(),
      env: environment(),
      checks: [],
      pass: false,
      fatal: `总时限 ${Math.round(BUDGET.total / 1000)}s 用尽,E2E 自行终止`,
      lastStage: stageLog.last()
    }
    writeReport(result)
    log('')
    log(result.fatal)
    return 1
  })
  try {
    const running = run()
    running.catch(() => undefined)
    code = await Promise.race([running, watchdog])
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    writeReport({ when: new Date().toISOString(), env: environment(), checks: [], pass: false, fatal: message })
    log('')
    log(`editor e2e: FAIL — ${message}`)
  } finally {
    await cleanup()
  }
  app.exit(code)
})

app.on('window-all-closed', () => {
  cleanup().catch((error) => log(`清理失败: ${error.message}`))
})
