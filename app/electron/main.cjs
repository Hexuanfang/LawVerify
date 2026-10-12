const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const OPEN_EXTERNAL_CHANNEL = 'lawverify:open-external'
const START_APP_UPDATE_CHANNEL = 'lawverify:start-app-update'
const APP_UPDATE_STATUS_CHANNEL = 'lawverify:app-update-status'
let appUpdateTask = null

function resolveDesktopUserDataPath() {
  const appDataRoot = app.getPath('appData')
  const preferredDir = path.join(appDataRoot, 'LawVerify')
  const legacyCandidates = [
    path.join(appDataRoot, 'LexVerify'),
    path.join(appDataRoot, 'lexverify-mvp'),
  ]

  if (fs.existsSync(preferredDir)) {
    return preferredDir
  }

  const legacyDir = legacyCandidates.find((targetPath) => fs.existsSync(targetPath))
  if (!legacyDir) {
    return preferredDir
  }

  fs.mkdirSync(preferredDir, { recursive: true })

  // Only migrate business data. Old Chromium cache/state can keep stale UI artifacts around.
  for (const name of ['data', 'storage', 'runtime']) {
    const sourcePath = path.join(legacyDir, name)
    const targetPath = path.join(preferredDir, name)
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
      continue
    }

    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true })
  }

  return preferredDir
}

app.setPath('userData', resolveDesktopUserDataPath())

const isDev = !app.isPackaged
const OFFICIAL_PLATFORM_BASE_URL = 'https://lawagent.zhijing.fun'
let desktopServer
let desktopServerUrl
let desktopServerPromise

// 渲染进程只与本机内置服务通信（云端请求由内置服务转发），禁用系统代理，
// 避免用户机器上的 VPN/代理工具拦截 Chromium 请求导致“无法连接账户服务”。
app.commandLine.appendSwitch('no-proxy-server')

if (!isDev) {
  // Some Windows packaged builds can lose keyboard focus/hit-testing in Chromium.
  // Software rendering is slower, but much more stable for login/input interactions.
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

function focusWindowContents(window) {
  if (!window || window.isDestroyed()) {
    return
  }

  if (window.isMinimized()) {
    window.restore()
  }

  if (!window.isVisible()) {
    window.show()
  }

  window.focus()
  window.webContents.focus()

  setTimeout(() => {
    if (window.isDestroyed()) {
      return
    }

    window.focus()
    window.webContents.focus()
    void window.webContents.executeJavaScript(`
      (() => {
        const isEditableElement = (element) => {
          if (!(element instanceof HTMLElement)) {
            return false
          }

          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            return !element.disabled && !element.readOnly
          }

          return element.isContentEditable
        }

        const loginCard = document.querySelector('.login-card')
        if (!loginCard) {
          return
        }

        const active = document.activeElement
        if (isEditableElement(active)) {
          return
        }

        const preferred =
          loginCard.querySelector('input:not([type="password"])')
          ?? loginCard.querySelector('input')

        if (isEditableElement(preferred)) {
          preferred.focus({ preventScroll: true })
        }
      })();
    `).catch(() => {})
  }, 80)
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: '律师证据质证助手',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.once('ready-to-show', () => {
    window.show()
    focusWindowContents(window)
  })

  window.on('restore', () => {
    focusWindowContents(window)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('did-finish-load', () => {
    focusWindowContents(window)
  })

  return window
}

function broadcastAppUpdateStatus(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }

    window.webContents.send(APP_UPDATE_STATUS_CHANNEL, payload)
  }
}

async function handleOpenExternal(_event, url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('缺少有效的跳转地址。')
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('跳转地址格式无效。')
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error('仅支持打开网页链接。')
  }

  await shell.openExternal(parsed.toString())
  return { ok: true }
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value))
    return /^https?:$/i.test(parsed.protocol)
  } catch {
    return false
  }
}

function sanitizeFileName(fileName) {
  return String(fileName || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

function getFileNameFromContentDisposition(headerValue) {
  if (!headerValue) {
    return ''
  }

  const encodedMatch = headerValue.match(/filename\*=UTF-8''([^;]+)/i)
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1].trim())
    } catch {
      return encodedMatch[1].trim()
    }
  }

  const plainMatch = headerValue.match(/filename="?([^";]+)"?/i)
  return plainMatch?.[1]?.trim() ?? ''
}

function resolveUpdateDownloadTarget(version, response) {
  const responseFileName = getFileNameFromContentDisposition(response.headers.get('content-disposition'))
  const fallbackFileName = `LawVerify-Setup-${String(version || app.getVersion()).trim() || app.getVersion()}.exe`
  const normalizedFileName = sanitizeFileName(responseFileName || fallbackFileName) || fallbackFileName
  const updatesDir = path.join(app.getPath('temp'), 'LawVerify', 'updates')
  fs.mkdirSync(updatesDir, { recursive: true })
  return {
    targetPath: path.join(updatesDir, normalizedFileName),
    tempPath: path.join(updatesDir, `${normalizedFileName}.part`),
  }
}

async function downloadUpdateInstaller(downloadUrl, version) {
  const response = await fetch(downloadUrl, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`更新安装包下载失败（${response.status || 'unknown'}）。`)
  }

  const { targetPath, tempPath } = resolveUpdateDownloadTarget(version, response)
  const totalBytes = Number(response.headers.get('content-length') || '0')
  const writer = fs.createWriteStream(tempPath)

  try {
    const reader = response.body.getReader()
    let receivedBytes = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      const chunk = Buffer.from(value)
      await new Promise((resolve, reject) => {
        writer.write(chunk, (error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })

      receivedBytes += chunk.length
      const progress = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : undefined
      broadcastAppUpdateStatus({
        status: 'downloading',
        version,
        progress,
        message: totalBytes > 0
          ? `正在下载更新安装包… ${progress}%`
          : '正在下载更新安装包…',
      })
    }

    await new Promise((resolve, reject) => {
      writer.end((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })

    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { force: true })
    }
    fs.renameSync(tempPath, targetPath)
    return targetPath
  } catch (error) {
    writer.destroy()
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true })
    }
    throw error
  }
}

function launchInstallerAndQuit(installerPath) {
  const child = spawn(installerPath, [], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  app.quit()
}

async function handleStartAppUpdate(_event, payload) {
  const version = String(payload?.version || '').trim()
  const downloadUrl = String(payload?.downloadUrl || '').trim()

  if (!version) {
    throw new Error('缺少更新版本号。')
  }

  if (!isValidHttpUrl(downloadUrl)) {
    throw new Error('更新下载地址无效。')
  }

  if (appUpdateTask) {
    throw new Error('更新安装包正在下载，请稍候。')
  }

  appUpdateTask = (async () => {
    broadcastAppUpdateStatus({
      status: 'downloading',
      version,
      progress: 0,
      message: `正在准备下载 v${version} 更新安装包…`,
    })

    const installerPath = await downloadUpdateInstaller(downloadUrl, version)
    broadcastAppUpdateStatus({
      status: 'ready',
      version,
      progress: 100,
      message: `v${version} 更新安装包已准备完成，正在启动安装程序…`,
    })
    launchInstallerAndQuit(installerPath)
    return { ok: true }
  })()
    .catch((error) => {
      const message = error instanceof Error ? error.message : '更新失败，请稍后重试。'
      broadcastAppUpdateStatus({
        status: 'error',
        version,
        message,
      })
      throw error
    })
    .finally(() => {
      appUpdateTask = null
    })

  return appUpdateTask
}

function probePort(port) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer()
    tester.unref()
    tester.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        resolve(false)
        return
      }

      reject(error)
    })
    tester.listen(port, '127.0.0.1', () => {
      tester.close(() => resolve(true))
    })
  })
}

async function findAvailablePort(startPort = 18787, attempts = 30) {
  for (let index = 0; index < attempts; index += 1) {
    const port = startPort + index
    const available = await probePort(port)
    if (available) {
      return port
    }
  }

  throw new Error('未找到可用的本地服务端口。')
}

function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const request = http.get(`${url}/api/health`, (response) => {
        response.resume()

        if (response.statusCode && response.statusCode < 500) {
          resolve()
          return
        }

        if (Date.now() >= deadline) {
          reject(new Error(`本地服务启动失败，状态码：${response.statusCode ?? 'unknown'}`))
          return
        }

        setTimeout(tryConnect, 250)
      })

      request.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error('等待本地服务启动超时。'))
          return
        }

        setTimeout(tryConnect, 250)
      })
    }

    tryConnect()
  })
}

function isLocalHostOrigin(value) {
  if (!value) {
    return true
  }
  const trimmed = String(value).trim()
  if (!trimmed) {
    return true
  }
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(trimmed)
}

function applyDesktopServerEnv(port) {
  const userDataDir = app.getPath('userData')
  const runtimeRoot = path.join(__dirname, '..', '.desktop', 'server')
  const frontendDistDir = path.join(__dirname, '..', 'dist')

  process.env.NODE_ENV = 'production'
  process.env.PORT = String(port)
  process.env.CORS_ORIGIN = `http://127.0.0.1:${port},http://localhost:${port}`
  process.env.JSON_LIMIT = process.env.JSON_LIMIT || '100mb'
  process.env.APP_RUNTIME_ROOT = runtimeRoot
  process.env.APP_DATA_ROOT = path.join(userDataDir, 'runtime')
  process.env.WORKSPACE_DATA_DIR = path.join(userDataDir, 'data')
  process.env.STORAGE_LOCAL_ROOT = path.join(userDataDir, 'storage')
  process.env.FRONTEND_DIST_DIR = frontendDistDir
  process.env.APP_PUBLIC_BASE_URL = `http://127.0.0.1:${port}`
  process.env.AUTO_RUN_MIGRATIONS = 'false'
  process.env.COLLABORA_PUBLIC_URL = ''

  if (!isDev && isLocalHostOrigin(process.env.CLOUD_API_BASE_URL)) {
    process.env.CLOUD_API_BASE_URL = OFFICIAL_PLATFORM_BASE_URL
  }
}

async function startPackagedServer() {
  if (desktopServerUrl) {
    return desktopServerUrl
  }

  if (desktopServerPromise) {
    return desktopServerPromise
  }

  desktopServerPromise = (async () => {
    const port = await findAvailablePort()
    applyDesktopServerEnv(port)

    const backendEntry = path.join(__dirname, '..', '.desktop', 'server', 'dist', 'app.js')
    const backendModule = await import(pathToFileURL(backendEntry).href)

    await backendModule.initializeCommercialInfrastructure()
    const bootstrap = backendModule.createApp()
    const server = await new Promise((resolve, reject) => {
      const instance = bootstrap.app.listen(port, '127.0.0.1', () => resolve(instance))
      instance.once('error', reject)
    })

    bootstrap.attachUpgrade(server)
    desktopServer = server
    desktopServerUrl = `http://127.0.0.1:${port}`
    await waitForServer(desktopServerUrl)
    return desktopServerUrl
  })()

  return desktopServerPromise
}

async function getAppUrl() {
  if (isDev) {
    return 'http://127.0.0.1:5173'
  }

  return startPackagedServer()
}

async function bootApplication() {
  const window = createWindow()

  try {
    const appUrl = await getAppUrl()
    await window.loadURL(appUrl)

    if (isDev) {
      window.webContents.openDevTools({ mode: 'detach' })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '桌面应用启动失败。'
    dialog.showErrorBox('LawVerify 启动失败', message)
    app.quit()
  }
}

// 单实例锁：第二个实例的内置服务与工作区会互相冲突（端口递增后内置服务可能崩溃，
// 表现为“无法连接账户服务”），因此重复启动时聚焦已有窗口，不再产生新实例。
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const existingWindow = BrowserWindow.getAllWindows()[0]
    if (!existingWindow) {
      return
    }
    if (existingWindow.isMinimized()) {
      existingWindow.restore()
    }
    existingWindow.show()
    focusWindowContents(existingWindow)
  })

  app.whenReady().then(() => {
    ipcMain.handle(OPEN_EXTERNAL_CHANNEL, handleOpenExternal)
    ipcMain.handle(START_APP_UPDATE_CHANNEL, handleStartAppUpdate)
    void bootApplication()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void bootApplication()
      }
    })
  })
}

app.on('before-quit', () => {
  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL)
  ipcMain.removeHandler(START_APP_UPDATE_CHANNEL)
  if (desktopServer) {
    desktopServer.close()
    desktopServer = undefined
    desktopServerUrl = undefined
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
