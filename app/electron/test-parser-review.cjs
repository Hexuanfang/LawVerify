const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const project = path.resolve(__dirname, '../..')
const directory = fs.mkdtempSync(path.join(project, 'tmp/parser-review-ui-'))
app.setPath('userData', path.join(directory, 'profile'))
app.disableHardwareAcceleration()
let server, window
ipcMain.handle('parser-qa-account', () => ({ status: 200, body: JSON.stringify({ success: true,
  data: { user: { email: 'parser-ui@test.invalid', name: '测试律师' }, organization: { id: 'qa', role: 'member' } } }) }))
const preload = path.join(directory, 'preload.cjs')
fs.writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('lawVerifyDesktop',{requestAccount:request=>ipcRenderer.invoke('parser-qa-account',request)})")

app.whenReady().then(async () => {
  try {
    const build = process.env.LAWVERIFY_REDESIGN_SERVER_DIST ?? path.join(project, 'server/dist')
    const { env } = await import(pathToFileURL(path.join(build, 'config/env.js')).href)
    Object.assign(env, { WORKSPACE_DATA_DIR: path.join(directory, 'data'), APP_DATA_ROOT: directory,
      STORAGE_LOCAL_ROOT: 'storage',
      FRONTEND_DIST_DIR: path.join(project, 'app/dist'), AI_GATEWAY_MODE: 'direct', KNOWLEDGE_RAG_MODE: 'local',
      LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' })
    fs.mkdirSync(path.join(directory, 'storage'), { recursive: true })
    fs.copyFileSync(path.join(project, 'server/eval/v2/assets/native-contract.pdf'), path.join(directory, 'storage/source.pdf'))
    const store = await import(pathToFileURL(path.join(build, 'store.js')).href)
    const account = 'parser-ui@test.invalid'
    await store.runWithWorkspaceAccount(account, async () => {
      const state = await store.readWorkspace()
      state.cases = [{ id: 'qa-case', name: '解析审核验证', description: '', status: 'draft', createdAt: '2026-11-16', agent: { autoAnalyze: false } }]
      state.certificates = []
      state.evidences = [{ id: 'qa-evidence', caseId: 'qa-case', type: 'pdf', name: '待审核合同', number: 'E01',
        fileName: 'source.pdf', storageKey: 'source.pdf', contentHash: 'qa', ocrText: '', uploadedAt: '2026-11-16',
        parsing: { status: 'review_required', revision: 'qa', sourceKey: 'qa', mode: 'auto', engineVersion: 'qa', updatedAt: '2026-11-16' } }]
      await store.writeWorkspace(state)
    })
    const backend = await import(pathToFileURL(path.join(build, 'app.js')).href)
    server = backend.createApp().app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    env.corsOrigins = [baseUrl]
    const asset = fs.readFileSync(path.join(env.FRONTEND_DIST_DIR, 'index.html'), 'utf8').match(/src="([^"]+\.js)"/)[1]
    const assetResponse = await fetch(baseUrl + asset)
    assert.equal(assetResponse.status, 200, `脚本资源读取失败 ${await assetResponse.text()}`)
    window = new BrowserWindow({ show: false, width: 1440, height: 1040,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
    window.webContents.on('console-message', event => fs.appendFileSync(path.join(directory, 'console.log'), `${event.message}\n`))
    const evaluate = source => window.webContents.executeJavaScript(source, true)
    const wait = async expression => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await evaluate(`Boolean(${expression})`)) return
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error(`界面等待超时 ${expression}`)
    }
    await window.loadURL(baseUrl)
    await evaluate(`sessionStorage.setItem('lawverify-auth-session','qa-session');sessionStorage.setItem('lawverify-login-account',${JSON.stringify(account)});location.reload()`)
    await wait("document.querySelector('.case-card')")
    await evaluate("document.querySelector('.case-card').click()")
    await wait("document.querySelector('.mat-it')")
    assert.equal(await evaluate("Boolean(document.querySelector('.mat-it svg[data-status=review_required]'))"), true, '待人工审核使用状态图标')
    await evaluate("document.querySelector('.mat-it').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))")
    await wait("document.querySelector('[role=tooltip]')?.textContent.includes('待人工审核')")
    await evaluate("document.querySelector('.mat-it').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))")
    await wait("!document.querySelector('[role=tooltip]')")
    await evaluate("document.querySelector('.mat-it svg[data-status=review_required]').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))")
    await wait("document.querySelector('[role=tooltip]')?.textContent.includes('待人工审核')")
    await evaluate("document.querySelector('.mat-it').click()")
    await wait("document.querySelector('.evidence-references')?.textContent.includes('暂无文书引用此材料')")
    assert.equal(await evaluate("document.querySelector('.new-drawer textarea, .new-drawer .evidence-manage')"), null)
    await wait("document.querySelector('.pdf-preview canvas')?.width > 0 && !document.querySelector('.pdf-preview [role=status]') && !document.querySelector('.pdf-preview [role=alert]')")
    fs.writeFileSync(path.join(directory, 'pending-review-preview.png'), (await window.webContents.capturePage()).toPNG())
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, directory }))
    console.log(`待审核材料状态与原件预览检查通过 ${directory}`)
    window.destroy()
    server.close(() => app.exit(0))
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'failure.txt'), error.stack || String(error))
    if (window && !window.isDestroyed()) {
      fs.writeFileSync(path.join(directory, 'failure.html'), await window.webContents.executeJavaScript('document.documentElement.outerHTML'))
      fs.writeFileSync(path.join(directory, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    }
    console.error(error)
    window?.destroy()
    server?.close()
    app.exit(1)
  }
})
