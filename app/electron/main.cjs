const { app, BrowserWindow, crashReporter, dialog, ipcMain, shell, utilityProcess } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { registerCaseDirectories } = require('./case-directories.cjs')
const { getUpdateFileName, validateUpdateFileName } = require('./update-platform.cjs')
const { createHash } = require('node:crypto')
const { ServiceSupervisor } = require('./service-supervisor.cjs')
const { createStabilityLog } = require('./stability-log.cjs')

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

const logStability = createStabilityLog(path.join(app.getPath('userData'), 'logs'))
let quitting = false
let serviceStatus = { state: 'idle' }
const isDev = !app.isPackaged
const OFFICIAL_PLATFORM_BASE_URL = 'https://lawagent.zhijing.fun'
let desktopServer
let desktopServerUrl
let desktopServerPromise

// 渲染进程只与本机内置服务通信（云端请求由内置服务转发），禁用系统代理，
// 避免用户机器上的 VPN/代理工具拦截 Chromium 请求导致“无法连接账户服务”。
app.commandLine.appendSwitch('no-proxy-server')

if (!isDev && process.platform === 'win32') {
  // Some Windows packaged builds can lose keyboard focus/hit-testing in Chromium.
  // Software rendering is slower, but much more stable for login/input interactions.
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

const authInputPrimedWindows = new WeakSet()

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
}

function primeAuthInputFocus(window) {
  if (!window || window.isDestroyed() || authInputPrimedWindows.has(window)) {
    return
  }

  setTimeout(() => {
    if (window.isDestroyed() || authInputPrimedWindows.has(window)) {
      return
    }

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
          return false
        }

        const active = document.activeElement
        if (isEditableElement(active)) {
          return true
        }

        const preferred =
          loginCard.querySelector('input:not([type="password"])')
          ?? loginCard.querySelector('input')

        if (isEditableElement(preferred)) {
          preferred.focus({ preventScroll: true })
          return true
        }

        return false
      })();
    `)
      .then((didPrime) => {
        if (didPrime && !window.isDestroyed()) {
          authInputPrimedWindows.add(window)
        }
      })
      .catch(() => {})
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
    primeAuthInputFocus(window)
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
    primeAuthInputFocus(window)
    window.webContents.send('lawverify:service-status', serviceStatus)
  })

  let recoveryPrompt = false
  const recoverWindow = async (reason) => {
    if (quitting || recoveryPrompt || window.isDestroyed()) return
    recoveryPrompt = true
    logStability('renderer-recovery-request', { reason })
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'LawVerify',
        message: reason === 'unresponsive' ? '当前窗口暂时无响应。' : '当前窗口意外中断。',
        detail: '恢复窗口后可继续工作，本地草稿会保留。尚未确认完成的操作，请检查结果后再重试。',
        buttons: ['恢复窗口', '暂不恢复'],
        defaultId: reason === 'unresponsive' ? 1 : 0,
        cancelId: 1,
      })
      if (response === 0 && !window.isDestroyed() && !quitting) {
        window.webContents.reload()
      }
    } finally { recoveryPrompt = false }
  }
  window.webContents.on('render-process-gone', (_event, details) => {
    logStability('renderer-process-gone', { reason: details.reason, code: details.exitCode })
    void recoverWindow(details.reason).catch(() => {})
  })
  let unresponsiveTimer
  window.on('unresponsive', () => {
    if (unresponsiveTimer) return
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null
      void recoverWindow('unresponsive').catch(() => {})
    }, 8000)
  })
  window.on('responsive', () => {
    clearTimeout(unresponsiveTimer)
    unresponsiveTimer = null
  })
  window.on('closed', () => clearTimeout(unresponsiveTimer))

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
  const fallbackFileName = getUpdateFileName(String(version || app.getVersion()).trim() || app.getVersion())
  const normalizedFileName = validateUpdateFileName(sanitizeFileName(responseFileName || fallbackFileName) || fallbackFileName)
  const updatesDir = path.join(app.getPath('temp'), 'LawVerify', 'updates')
  fs.mkdirSync(updatesDir, { recursive: true })
  return {
    targetPath: path.join(updatesDir, normalizedFileName),
    tempPath: path.join(updatesDir, `${normalizedFileName}.part`),
  }
}

async function downloadUpdateInstaller(downloadUrl, version, expectedSha256) {
  const response = await fetch(downloadUrl, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`更新安装包下载失败（${response.status || 'unknown'}）。`)
  }

  const { targetPath, tempPath } = resolveUpdateDownloadTarget(version, response)
  const totalBytes = Number(response.headers.get('content-length') || '0')
  const writer = fs.createWriteStream(tempPath)
  const hash = createHash('sha256')

  try {
    const reader = response.body.getReader()
    let receivedBytes = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      const chunk = Buffer.from(value)
      hash.update(chunk)
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

    if (expectedSha256 && hash.digest('hex') !== expectedSha256.toLowerCase()) {
      throw new Error('安装包完整性校验失败，请重新下载更新。')
    }
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

async function launchInstallerAndQuit(installerPath) {
  if (process.platform === 'darwin') {
    const error = await shell.openPath(installerPath)
    if (error) throw new Error('无法打开更新安装包，请从官网下载后安装。')
    app.quit()
    return
  }
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
  const sha256 = String(payload?.sha256 || '').trim()

  if (!version) {
    throw new Error('缺少更新版本号。')
  }

  if (!isValidHttpUrl(downloadUrl)) {
    throw new Error('更新下载地址无效。')
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('缺少有效的安装包校验值，请从官网下载最新版本。')
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

    const installerPath = await downloadUpdateInstaller(downloadUrl, version, sha256)
    broadcastAppUpdateStatus({
      status: 'ready',
      version,
      progress: 100,
      message: process.platform === 'darwin'
        ? `v${version} 已下载，请将 LawVerify 拖入“应用程序”替换旧版。`
        : `v${version} 更新安装包已准备完成，正在启动安装程序…`,
    })
    await launchInstallerAndQuit(installerPath)
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

  throw new Error('本地服务端口被占用，请关闭其他 LawVerify 进程后重试。')
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
  process.env.LAWVERIFY_DESKTOP = '1'
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
  if (desktopServerUrl && desktopServer?.state === 'ready') {
    return desktopServerUrl
  }

  if (desktopServerPromise) {
    return desktopServerPromise
  }
  if (desktopServer) {
    if (desktopServer.state === 'failed') throw new Error('本地服务恢复失败，请重新打开 LawVerify。')
    await desktopServer.waitUntilReady()
    return desktopServerUrl
  }

  desktopServerPromise = (async () => {
    // Draft storage is origin-bound. Never silently change ports between launches.
    const port = await findAvailablePort(18787, 1)
    applyDesktopServerEnv(port)

    desktopServerUrl = `http://127.0.0.1:${port}`
    const serviceEnv = { ...process.env }
    delete serviceEnv.ELECTRON_RUN_AS_NODE
    desktopServer = new ServiceSupervisor({
      fork: (...args) => utilityProcess.fork(...args),
      entry: path.join(__dirname, 'desktop-service.cjs'),
      env: serviceEnv,
    })
    desktopServer.on('diagnostic', ({ event, ...details }) => logStability(event, details))
    desktopServer.on('status', status => {
      serviceStatus = status
      logStability(`service-${status.state}`)
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('lawverify:service-status', status)
      }
    })
    await desktopServer.waitUntilReady()
    return desktopServerUrl
  })().finally(() => { desktopServerPromise = null })

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
    crashReporter.start({ uploadToServer: false, compress: true })
    registerCaseDirectories({ app, ipcMain, dialog, BrowserWindow })
    ipcMain.handle('lawverify:get-service-status', () => serviceStatus)
    const diagnosticTimes = new Map()
    ipcMain.on('lawverify:renderer-diagnostic', (event, payload) => {
      if (!BrowserWindow.fromWebContents(event.sender) || !payload || typeof payload.event !== 'string') return
      if (!['renderer-error', 'renderer-rejection', 'react-boundary', 'renderer-long-task', 'draft-storage-failed'].includes(payload.event)) return
      const key = `${event.sender.id}:${payload.event}`
      if (Date.now() - (diagnosticTimes.get(key) ?? 0) < 10000) return
      diagnosticTimes.set(key, Date.now())
      logStability(payload.event, { duration: payload.duration, count: payload.count })
    })
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
  quitting = true
  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL)
  ipcMain.removeHandler(START_APP_UPDATE_CHANNEL)
  ipcMain.removeHandler('lawverify:get-service-status')
  if (desktopServer) {
    desktopServer.stop()
    desktopServer = undefined
    desktopServerUrl = undefined
  }
})

process.on('uncaughtException', () => {
  logStability('main-uncaught-exception')
  app.exit(1)
})
process.on('unhandledRejection', () => {
  logStability('main-unhandled-rejection')
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
