'use strict'

/** Run the gate N times and report the spread, so a limit can be set from a
 *  distribution instead of from one run.
 *
 *  `npm run perf:spread -- --runs 5`
 *
 *  Every threshold in perf/thresholds.json rests on a range, and the ranges were
 *  assembled by hand from console output across a working session. That does not
 *  scale and it does not repeat: the four memory limits are coarse precisely because
 *  nobody could say more than "it moved a lot between the runs I happened to do", and
 *  one of them (`jsHeapCommittedPeakMiB <= 100`) failed three runs out of five on
 *  unchanged code before anyone noticed it was the *limit* that was wrong.
 *
 *  So this is the missing instrument. It runs the gate as a child process N times,
 *  keeps each run's JSON, and prints min / median / max / spread for every number the
 *  gate judges — plus how many runs passed. Flags after `--` reach the gate, so
 *  `--gc-marks` measures the diagnostic mode's spread the same way.
 *
 *  It does not change any threshold. Reading a distribution and choosing a limit is a
 *  judgement about how much noise is acceptable, and that stays with a person. */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const electron = require('electron')
const REPO = path.resolve(__dirname, '..')
const RUNS_DIR = path.join(__dirname, 'runs')
const SPREAD_FILE = path.join(__dirname, 'spread.json')

const argv = process.argv.slice(2)

function flagNumber(flag, fallback) {
  const index = argv.indexOf(flag)
  if (index < 0) return fallback
  const value = Number(argv[index + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const RUNS = flagNumber('--runs', 5)
/** Everything except our own flags is handed to the gate unchanged. */
const PASSTHROUGH = argv.filter((arg, index) => arg !== '--runs' && argv[index - 1] !== '--runs')

/** What to aggregate: the numbers the gate judges, plus the two row counts that are
 *  supposed to be identical every time — a spread there is a finding on its own. */
const METRICS = [
  ['open first', 'drive.openFirst', 'ms'],
  ['open steady P95', 'drive.openSteady.p95', 'ms'],
  ['input → painted P95', 'drive.inputPaint.p95', 'ms'],
  ['input → painted max', 'drive.inputPaint.max', 'ms'],
  ['tab switch P95', 'drive.tabSwitch.p95', 'ms'],
  ['inline rows modelled', 'drive.inline.rowsTotal', ''],
  ['inline rows in the DOM', 'drive.inline.rowsMountedPeak', ''],
  ['inline → painted', 'drive.inline.showMs', 'ms'],
  ['inline scroll P95', 'drive.inline.scroll.p95', 'ms'],
  ['expanded rows modelled', 'drive.inline.fullRowsTotal', ''],
  ['expanded rows in the DOM', 'drive.inline.fullRowsMountedPeak', ''],
  ['expanded → painted', 'drive.inline.fullShowMs', 'ms'],
  ['renderer peak', 'memory.rendererPeakMiB', 'MiB'],
  ['loadDelta', 'memory.loadDeltaMiB', 'MiB'],
  ['inlineDelta', 'memory.inlineDeltaMiB', 'MiB'],
  ['JS heap committed peak', 'memory.jsHeapCommittedPeakMiB', 'MiB'],
  ['retained after close', 'memory.retainedDeltaMiB', 'MiB'],
  ['JS heap retained', 'memory.jsHeapRetainedMiB', 'MiB']
]

function log(message) {
  process.stdout.write(`[spread] ${message}\n`)
}

function read(source, dotted) {
  return dotted.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), source)
}

function round(value) {
  return Math.round(value * 10) / 10
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** One gate run, as a child process. Its own watchdog bounds it; this only waits. */
function runGate(index) {
  const file = path.join(RUNS_DIR, `run-${String(index + 1).padStart(2, '0')}.json`)
  return new Promise((resolve) => {
    const child = spawn(electron, [path.join(__dirname, 'editor-load.cjs'), '--json', file, ...PASSTHROUGH], {
      cwd: REPO,
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: false
    })
    child.on('exit', (code) => resolve({ file, code }))
    child.on('error', () => resolve({ file, code: null }))
  })
}

function summarise(results) {
  const rows = []
  for (const [name, dotted, unit] of METRICS) {
    const values = results
      .map((result) => read(result, dotted))
      .filter((value) => typeof value === 'number' && Number.isFinite(value))
    if (values.length === 0) continue
    const sorted = [...values].sort((a, b) => a - b)
    const min = sorted[0]
    const max = sorted[sorted.length - 1]
    rows.push({
      name,
      unit,
      samples: values.length,
      min: round(min),
      median: round(median(sorted)),
      max: round(max),
      // Against the minimum, because that is the question a limit asks: how much
      // higher than a good run does a bad-but-fine run get?
      spreadPercent: min > 0 ? Math.round(((max - min) / min) * 100) : null
    })
  }
  return rows
}

function report(rows, passed, total) {
  const width = Math.max(...rows.map((row) => row.name.length))
  log('')
  log(`${'metric'.padEnd(width)}   ${'min'.padStart(8)} ${'median'.padStart(8)} ${'max'.padStart(8)}   spread`)
  for (const row of rows) {
    const unit = row.unit ? ` ${row.unit}` : ''
    log(
      `${row.name.padEnd(width)}   ${String(row.min).padStart(8)} ${String(row.median).padStart(8)} ${String(row.max).padStart(8)}${unit}   ` +
      `${row.spreadPercent === null ? '—' : `${row.spreadPercent}%`}${row.samples < total ? ` (${row.samples}/${total} 次有值)` : ''}`
    )
  }
  log('')
  log(`${passed}/${total} 次运行通过当前阈值`)
  log(`written to ${path.relative(REPO, SPREAD_FILE)} · 每次运行的原始结果在 ${path.relative(REPO, RUNS_DIR)}`)
  log('阈值不会被自动改动:读一个分布然后决定容忍多少噪声,是人的判断。')
}

async function main() {
  fs.mkdirSync(RUNS_DIR, { recursive: true })
  log(`${RUNS} 次运行${PASSTHROUGH.length > 0 ? ` · 传给门槛: ${PASSTHROUGH.join(' ')}` : ''}`)
  const results = []
  let passed = 0
  for (let index = 0; index < RUNS; index++) {
    log(`run ${index + 1}/${RUNS}…`)
    const { file, code } = await runGate(index)
    if (!fs.existsSync(file)) {
      log(`run ${index + 1} 没有产出结果文件(退出码 ${code}),跳过`)
      continue
    }
    const result = JSON.parse(fs.readFileSync(file, 'utf8'))
    results.push(result)
    if (result.pass === true) passed++
    else log(`run ${index + 1} 未通过阈值 —— 仍然计入分布`)
  }
  if (results.length === 0) {
    log('没有任何一次运行产出结果,无法给出分布')
    process.exit(1)
  }
  const rows = summarise(results)
  const spread = {
    when: new Date().toISOString(),
    runs: results.length,
    requested: RUNS,
    passed,
    passthrough: PASSTHROUGH,
    env: results[0].env,
    metrics: rows
  }
  fs.writeFileSync(SPREAD_FILE, JSON.stringify(spread, null, 2) + '\n', 'utf8')
  report(rows, passed, results.length)
  // The spread itself is the product; a run that failed its thresholds is data, not
  // an error here. Only "nothing ran" is a failure.
  process.exit(0)
}

main().catch((error) => {
  log(`失败: ${error && error.stack ? error.stack : String(error)}`)
  process.exit(1)
})
