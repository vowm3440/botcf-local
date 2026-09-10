// BotCF 桌面壳:主进程内启动本地控制服务(与 Docker 版同一份 server 代码),
// 窗口加载 http://127.0.0.1:7788。
// 开发模式:用系统 Node 跑 apps/server/dist/server.js。
// 打包模式:服务端已被 esbuild 打成单文件、无原生依赖,直接用 Electron 内嵌
// Node(ELECTRON_RUN_AS_NODE)运行,最终用户无需安装 Node.js。
const { app, BrowserWindow, dialog, session } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

const PORT = 7788
const SERVER_URL = `http://127.0.0.1:${PORT}`

let serverProc = null
let mainWindow = null
let quitting = false
let shutdownPending = false

async function resolveSystemProxyEnv() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return {}
  try {
    const rules = await session.defaultSession.resolveProxy('https://api.github.com')
    const proxyRule = rules
      .split(';')
      .map((rule) => rule.trim())
      .find((rule) => /^(?:PROXY|HTTPS)\s+/i.test(rule))
    if (!proxyRule) return {}
    const endpoint = proxyRule.replace(/^(?:PROXY|HTTPS)\s+/i, '')
    const proxyUrl = endpoint.includes('://') ? endpoint : `http://${endpoint}`
    return { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }
  } catch {
    return {}
  }
}

function startServer(networkEnv = {}) {
  const packaged = app.isPackaged
  const entry = packaged
    ? path.join(process.resourcesPath, 'server', 'server.bundle.cjs')
    : path.join(__dirname, '..', 'server', 'dist', 'server.js')
  const webDist = packaged
    ? path.join(process.resourcesPath, 'web')
    : path.join(__dirname, '..', 'web', 'dist')

  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    BOTCF_DATA_DIR: path.join(app.getPath('userData'), 'data'),
    WEB_DIST_DIR: webDist,
    ...networkEnv
  }

  let command
  if (packaged) {
    command = process.execPath
    env.ELECTRON_RUN_AS_NODE = '1'
  } else {
    command = process.platform === 'win32' ? 'node.exe' : 'node'
  }

  serverProc = spawn(command, [entry], { env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], shell: false })
  serverProc.on('error', (err) => {
    serverProc = null
    dialog.showErrorBox('无法启动本地服务', `${err.message}\n${packaged ? '' : '开发模式需要系统已安装 Node.js 22+ 且在 PATH 中。'}`)
    app.quit()
  })
  serverProc.on('exit', (code) => {
    serverProc = null
    if (!quitting && code !== 0 && code !== null && mainWindow) {
      dialog.showErrorBox('BotCF 本地服务异常退出', `退出码 ${code},请查看日志。`)
    }
  })
}

function waitForHealth(retries = 50) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = http.get(`${SERVER_URL}/health`, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve()
        retry(left)
      })
      req.on('error', () => retry(left))
      req.setTimeout(1000, () => req.destroy())
    }
    const retry = (left) => {
      if (left <= 0) return reject(new Error('本地服务启动超时'))
      setTimeout(() => attempt(left - 1), 200)
    }
    attempt(retries)
  })
}

function createWindow() {
  // Packaged builds take the icon from the exe's resources; `electron .` during
  // development has none, so point it at the same file the build embeds.
  const devIcon = path.join(__dirname, 'build', 'icon.ico')
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    ...(app.isPackaged || !fs.existsSync(devIcon) ? {} : { icon: devIcon }),
    // The build identifies itself: a portable copy and an installed one look the
    // same in the taskbar, and "which version am I looking at" should not require
    // opening a settings panel.
    title: `BotCF 本地控制台 v${app.getVersion()}`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.loadURL(SERVER_URL)
  // The page owns its own title, so keep it and append the build's version rather
  // than letting the document overwrite it on load.
  mainWindow.on('page-title-updated', (event, title) => {
    event.preventDefault()
    mainWindow?.setTitle(`${title} v${app.getVersion()}`)
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    const networkEnv = await resolveSystemProxyEnv()
    if (quitting) return
    startServer(networkEnv)
    try {
      await waitForHealth()
    } catch (err) {
      if (quitting) return
      dialog.showErrorBox('启动失败', String(err))
      app.quit()
      return
    }
    if (quitting) return
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    quitting = true
    if (!serverProc) return
    event.preventDefault()
    if (shutdownPending) return
    shutdownPending = true
    const child = serverProc
    const forceStop = () => {
      if (child.exitCode !== null) return
      if (process.platform === 'win32') {
        // Windows kill() skips Node's signal handlers; kill the tree only if
        // the IPC shutdown did not finish within the server's cleanup budget.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        killer.on('error', () => child.kill())
      } else {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(forceStop, 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      serverProc = null
      app.quit()
    })
    if (child.connected) {
      child.send({ type: 'shutdown' }, (error) => { if (error) forceStop() })
    } else {
      forceStop()
    }
  })
}
