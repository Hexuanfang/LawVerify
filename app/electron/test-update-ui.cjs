const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const temporary = process.env.LAWVERIFY_TEST_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-update-ui-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
const dist = path.resolve(__dirname, '../dist')

function installFixture(platform) {
  const listeners = []
  window.updateQueries = []
  window.lawVerifyDesktop = {
    platform, arch: platform === 'darwin' ? 'arm64' : 'x64', channel: 'electron',
    requestAccount: ({ path }) => {
      if (!path.startsWith('/api/web/releases/latest')) {
        return Promise.resolve({ status: 503, body: '{}' })
      }
      window.updateQueries.push(path)
      return new Promise(resolve => {
        window.resolveUpdate = data => resolve({ status: 200, body: JSON.stringify({ success: true, data }) })
        window.failUpdate = () => resolve({ status: 0, body: '', code: 'ERR_NAME_NOT_RESOLVED' })
      })
    },
    onAppUpdateStatus: listener => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
    startAppUpdate: payload => new Promise(resolve => {
      window.updatePayload = payload
      listeners.forEach(listener => listener({ status: 'downloading', progress: 42, message: '正在下载更新安装包… 42%' }))
      window.failDownload = () => {
        listeners.forEach(listener => listener({ status: 'error', message: '安装包完整性校验失败，请重新下载更新。' }))
        resolve({ ok: false })
      }
    }),
  }
}

app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (pathname.startsWith('/api/')) {
      response.writeHead(503, { 'content-type': 'application/json' }).end('{}')
      return
    }
    const file = path.join(dist, pathname === '/' ? 'index.html' : pathname)
    if (!file.startsWith(`${dist}${path.sep}`) || !fs.existsSync(file)) {
      response.writeHead(404).end()
      return
    }
    const extension = path.extname(file)
    response.setHeader('content-type', extension === '.html' ? 'text/html; charset=utf-8'
      : extension === '.css' ? 'text/css' : 'text/javascript')
    const bytes = fs.readFileSync(file)
    response.end(extension === '.html'
      ? bytes.toString().replace('<head>', `<head><script>(${installFixture.toString()})(${JSON.stringify(process.env.LAWVERIFY_TEST_PLATFORM || 'darwin')})</script>`)
      : bytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  const evaluate = expression => window.webContents.executeJavaScript(expression)
  const wait = expression => evaluate(`new Promise((resolve, reject) => {
    const check = () => { if (${expression}) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('UI state timed out')); }, 5000);
    check();
  })`)
  const click = label => evaluate(`Array.from(document.querySelectorAll('.app-update-card button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await wait("document.querySelector('.app-update-card')?.textContent.includes('检查中...')")
    assert.equal(await evaluate("document.querySelector('.app-update-card button').disabled"), true)
    await evaluate('window.resolveUpdate(null)')
    await wait("document.querySelector('.app-update-card')?.textContent.includes('暂未发布')")
    assert.equal(await evaluate("document.querySelector('.app-update-card').textContent.includes('已是最新')"), false)
    const isWindows = process.env.LAWVERIFY_TEST_PLATFORM === 'win32'
    if (isWindows) assert.equal(await evaluate("document.querySelector('.app-update-card').textContent.includes('检查测试版')"), false)
    await click(isWindows ? '检查更新' : '检查测试版')
    await wait("document.querySelector('.app-update-card')?.textContent.includes('检查中...')")
    assert.match(await evaluate('window.updateQueries.at(-1)'), isWindows
      ? /platform=win32&arch=x64&channel=stable/ : /platform=darwin&arch=arm64&channel=test/)
    const release = {
      id: 'test-release', version: '0.1.99', platform: isWindows ? 'win32' : 'darwin',
      arch: isWindows ? 'x64' : 'arm64', channel: isWindows ? 'stable' : 'test',
      sizeLabel: '130 MB', sha256: 'a'.repeat(64),
      downloadUrl: isWindows ? 'https://example.test/LawVerify-Setup-0.1.99.exe'
        : 'https://example.test/LawVerify-Mac-0.1.99-arm64-unsigned.dmg',
    }
    await evaluate(`window.resolveUpdate(${JSON.stringify(release)})`)
    await wait("document.querySelector('.app-update-card')?.textContent.includes('0.1.99')")
    await click(isWindows ? '一键更新' : '下载并安装')
    await wait("document.querySelector('.app-update-card')?.textContent.includes('42%')")
    assert.equal(await evaluate('window.updatePayload.channel'), isWindows ? 'stable' : 'test')
    assert.equal(await evaluate('window.updatePayload.downloadUrl'), release.downloadUrl)
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.app-update-card button')).every(button => button.disabled)"), true)
    await evaluate('window.failDownload()')
    await wait("document.querySelector('.app-update-card')?.textContent.includes('完整性校验失败')")
    await click('检查更新')
    await wait("document.querySelector('.app-update-card')?.textContent.includes('检查中...')")
    await evaluate('window.failUpdate()')
    await wait("document.querySelector('.app-update-card')?.textContent.includes('检查更新失败')")
    assert.equal(await evaluate("document.querySelector('.app-update-card button').disabled"), false)
    console.log(`PASS rendered ${isWindows ? 'Windows' : 'Mac'} UI: checking feedback, no false latest, correct release channel, download progress, checksum failure and network retry`)
    window.destroy()
    server.closeAllConnections()
    server.close()
    app.exit(0)
  } catch (error) {
    console.error(error.stack)
    server.closeAllConnections()
    server.close()
    app.exit(1)
  }
})
