/** The Windows release entry point: `npm run dist -w apps/desktop`.
 *
 *  It exists because "electron-builder --win" on its own shipped the default
 *  Electron icon. The config named `build/icon.ico`, nothing generated that
 *  file, electron-builder logged `default Electron icon is used` and carried on,
 *  and NSIS then failed on the same missing path. Three separate signals, none
 *  of them fatal to the command that was supposed to produce a release.
 *
 *  So this script owns the sequence and the verdict:
 *
 *    1. generate the icon (deterministic — build/generate-icon.mjs),
 *    2. check the container really holds a 256×256 PNG image,
 *    3. run electron-builder, watching its log for the default-icon notice,
 *    4. read the icon resources back out of the produced PE files.
 *
 *  Any one of those failing fails the build. Step 4 is the one that matters: it
 *  is the only check the previous fix would not have passed. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeIcon } from './generate-icon.mjs'
import { readIcoImages, readPeIcons } from './icon-pe.mjs'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = path.join(DESKTOP, 'release')
const PACKAGE = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))

/** electron-builder says this when it cannot find the configured icon. It is a
 *  plain log line, not an error, which is exactly why it needs gating. */
const DEFAULT_ICON_NOTICE = /default Electron icon is used/i

const log = (message) => process.stdout.write(`[dist] ${message}\n`)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

class BuildFailure extends Error {}

/** Workspace dependencies are hoisted to the repo root, so walk up for them. */
function resolveUp(relative) {
  let dir = DESKTOP
  for (;;) {
    const candidate = path.join(dir, 'node_modules', relative)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function electronBuilderCli() {
  const cli = resolveUp(path.join('electron-builder', 'cli.js'))
  if (!cli) throw new BuildFailure('找不到 electron-builder,先执行 npm ci')
  return cli
}

function runElectronBuilder(args) {
  const cli = electronBuilderCli()
  log(`electron-builder ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: DESKTOP, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const capture = (stream, sink) => {
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        output += chunk
        sink.write(chunk)
      })
    }
    capture(child.stdout, process.stdout)
    capture(child.stderr, process.stderr)
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, output }))
  })
}

/** The icon the release is supposed to carry, as electron-builder will embed it. */
function prepareIcon() {
  const file = writeIcon()
  const buffer = fs.readFileSync(file)
  const images = readIcoImages(buffer)
  const large = images.filter((image) => image.width >= 256 && image.height >= 256 && image.isPng)
  if (large.length === 0) {
    throw new BuildFailure(`${path.relative(DESKTOP, file)} 不含 256×256 PNG 图像(electron-builder 会拒绝或退回默认图标)`)
  }
  log(`icon ${path.relative(DESKTOP, file)} — ${images.length} 张图像, ${buffer.length} 字节, sha256 ${sha(buffer).slice(0, 12)}…`)
  return { file, digests: new Set(images.map((image) => sha(image.bytes))) }
}

/** The icon fingerprint of the stock Electron binary. The bug this gate exists
 *  for shipped an exe whose icon resources were byte-identical to these, so
 *  matching them is a positive identification of the failure, not a guess. */
function electronDefaultDigests() {
  const electronExe = resolveUp(path.join('electron', 'dist', 'electron.exe'))
  if (!electronExe) return null
  try {
    return new Set(readPeIcons(fs.readFileSync(electronExe)).map((icon) => sha(icon.bytes)))
  } catch {
    return null
  }
}

/** Every PE the release produces that must carry the product icon. */
function artifactsToVerify() {
  const version = PACKAGE.version
  return [
    { label: '主程序', file: path.join(RELEASE, 'win-unpacked', `${PACKAGE.build.productName}.exe`) },
    { label: 'Portable', file: path.join(RELEASE, `BotCF-Local-v${version}-portable.exe`) },
    { label: 'Setup', file: path.join(RELEASE, `BotCF-Local-v${version}-Setup.exe`) }
  ]
}

/** Read the icon resources back out of one produced PE and say which icon they
 *  are: ours, Electron's stock one, or something neither of us put there. All
 *  three verdicts are stated — an unidentified icon in a release is the same
 *  ambiguity that let the default one ship. */
function verifyArtifact(artifact, icon, electronDigests) {
  if (!fs.existsSync(artifact.file)) return `${artifact.label} 不存在: ${path.relative(DESKTOP, artifact.file)}`
  let icons
  try {
    icons = readPeIcons(fs.readFileSync(artifact.file))
  } catch (error) {
    return `${artifact.label} 的 PE 资源无法解析: ${error.message}`
  }
  if (icons.length === 0) return `${artifact.label} 没有任何 RT_ICON 资源(外壳会自行挑一个图标)`

  const digests = icons.map((entry) => sha(entry.bytes))
  if (digests.some((digest) => icon.digests.has(digest))) {
    log(`PASS  ${artifact.label} 图标资源即产品图标 (${icons.length} 个 RT_ICON,含匹配项)`)
    return null
  }
  if (electronDigests && digests.some((digest) => electronDigests.has(digest))) {
    return `${artifact.label} 带的是 Electron 默认图标(指纹与 node_modules/electron/dist/electron.exe 相同)`
  }
  return (
    `${artifact.label} 的图标资源既不是产品图标也不是 Electron 默认图标 —— ` +
    `${icons.length} 个 RT_ICON,大小 ${icons.map((entry) => entry.size).join('/')} 字节,` +
    `sha256 ${digests.map((digest) => digest.slice(0, 8)).join('/')}`
  )
}

function verifyArtifacts(icon) {
  const electronDigests = electronDefaultDigests()
  if (!electronDigests) log('NOTE  未能读取 Electron 默认图标指纹,失败时只能报告"不是产品图标"')
  return artifactsToVerify()
    .map((artifact) => verifyArtifact(artifact, icon, electronDigests))
    .filter((problem) => problem !== null)
}

/** What this gate does *not* prove, said out loud rather than left to be assumed.
 *  The uninstaller is compiled into the NSIS installer's compressed payload, so
 *  its icon cannot be read back without running the installer. The config slot
 *  that decides it is checked instead. */
function reportUninstallerCoverage(icon) {
  const nsis = PACKAGE.build.nsis ?? {}
  const expected = path.relative(DESKTOP, icon.file).split(path.sep).join('/')
  const slots = ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']
  const wrong = slots.filter((slot) => nsis[slot] !== expected)
  if (wrong.length > 0) {
    return [`package.json 的 NSIS 图标槽位 ${wrong.join('/')} 未指向 ${expected}`]
  }
  log(`NOTE  卸载器图标由 NSIS 在编译期写入压缩负载,无法回读;已断言 ${slots.join('/')} 均指向 ${expected}`)
  return []
}

async function main() {
  const icon = prepareIcon()
  const uninstaller = reportUninstallerCoverage(icon)

  const { code, output } = await runElectronBuilder(['--win'])
  const problems = [...uninstaller]
  if (code !== 0) problems.push(`electron-builder 退出码 ${code}`)
  if (DEFAULT_ICON_NOTICE.test(output)) problems.push('electron-builder 日志出现 “default Electron icon is used”,产物会带默认 Electron 图标')

  // Only worth reading the PEs when the build claims to have produced them; a
  // failed build would just add "not found" noise on top of its own error.
  if (code === 0) problems.push(...verifyArtifacts(icon))

  if (problems.length > 0) {
    log('')
    for (const problem of problems) log(`FAIL  ${problem}`)
    log('')
    log('发布门槛: FAIL')
    return 1
  }
  log('')
  log('发布门槛: PASS — 退出码 0、无默认图标日志、主程序/Portable/Setup 图标资源均为产品图标')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log(`FAIL  ${error instanceof BuildFailure ? error.message : (error?.stack ?? String(error))}`)
    log('发布门槛: FAIL')
    process.exit(1)
  })
