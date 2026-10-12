const { app, BrowserWindow, dialog, shell } = require('electron')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

function resolveDesktopUserDataPath() {
  const appDataRoot = app.getPath('appData')
  const preferredDir = path.join(appDataRoot, 'LawVerify')
  const legacyCandidates = [
    preferredDir,
    path.join(appDataRoot, 'LexVerify'),
    path.join(appDataRoot, 'lexverify-mvp'),
  ]

  const existingDir = legacyCandidates.find((targetPath) => fs.existsSync(targetPath))
  return existingDir ?? preferredDir
}

app.setPath('userData', resolveDesktopUserDataPath())

const isDev = !app.isPackaged
let desktopServer
let desktopServerUrl
let desktopServerPromise

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

        const active = document.activeElement
        if (isEditableElement(active)) {
          return
        }

        const preferred =
          document.querySelector('.login-card input:not([type="password"])')
          ?? document.querySelector('.login-card input')
          ?? document.querySelector('input, textarea, [contenteditable="true"]')

        if (isEditableElement(preferred)) {
          preferred.focus()
          if ('select' in preferred && typeof preferred.select === 'function') {
            preferred.select()
          }
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

  window.on('focus', () => {
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

app.whenReady().then(() => {
  void bootApplication()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void bootApplication()
    }
  })
})

app.on('before-quit', () => {
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
