// BotCF 桌面壳:主进程内启动本地控制服务(与 Docker 版同一份 server 代码),
// 窗口加载 http://127.0.0.1:7788。
// 开发模式:用系统 Node 跑 apps/server/dist/server.js。
// 打包模式:服务端已被 esbuild 打成单文件、无原生依赖,直接用 Electron 内嵌
// Node(ELECTRON_RUN_AS_NODE)运行,最终用户无需安装 Node.js。
const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')

const PORT = 7788
const SERVER_URL = `http://127.0.0.1:${PORT}`

let serverProc = null
let mainWindow = null

function startServer() {
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
    WEB_DIST_DIR: webDist
  }

  let command
  if (packaged) {
    command = process.execPath
    env.ELECTRON_RUN_AS_NODE = '1'
  } else {
    command = process.platform === 'win32' ? 'node.exe' : 'node'
  }

  serverProc = spawn(command, [entry], { env, stdio: 'inherit', shell: false })
  serverProc.on('error', (err) => {
    dialog.showErrorBox('无法启动本地服务', `${err.message}\n${packaged ? '' : '开发模式需要系统已安装 Node.js 22+ 且在 PATH 中。'}`)
    app.quit()
  })
  serverProc.on('exit', (code) => {
    serverProc = null
    if (code !== 0 && code !== null && mainWindow) {
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
      req.setTimeout(1000, () => { req.destroy(); retry(left) })
    }
    const retry = (left) => {
      if (left <= 0) return reject(new Error('本地服务启动超时'))
      setTimeout(() => attempt(left - 1), 200)
    }
    attempt(retries)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'BotCF 本地控制台',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.loadURL(SERVER_URL)
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
    startServer()
    try {
      await waitForHealth()
    } catch (err) {
      dialog.showErrorBox('启动失败', String(err))
      app.quit()
      return
    }
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    if (serverProc) {
      serverProc.kill()
      serverProc = null
    }
  })
}
