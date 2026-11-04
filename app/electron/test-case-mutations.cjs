const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-case-ui-'))
app.setPath('userData', directory)
app.disableHardwareAcceleration()
let server, window
const messages = []
app.whenReady().then(async () => {
  try {
    const serverRoot = path.resolve(__dirname, '../../server/dist')
    const { env } = await import(pathToFileURL(path.join(serverRoot, 'config/env.js')).href)
    Object.assign(env, { WORKSPACE_DATA_DIR: path.join(directory, 'data'), APP_DATA_ROOT: directory,
      STORAGE_LOCAL_ROOT: 'storage', FRONTEND_DIST_DIR: path.resolve(__dirname, '../dist'),
      corsOrigins: ['http://127.0.0.1:8787'],
      AI_GATEWAY_MODE: 'direct', KNOWLEDGE_RAG_MODE: 'local', LLM_BASE_URL: undefined, LLM_API_KEY: undefined })
    const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import(pathToFileURL(path.join(serverRoot, 'store.js')).href)
    await runWithWorkspaceAccount('case-ui@test.invalid', async () => {
      const workspace = await readWorkspace()
      workspace.cases = [{ id: 'existing', name: 'Existing case', description: '', status: 'draft', createdAt: '2026-11-03' }]
      workspace.certificates = [{ id: 'document', caseId: 'existing', title: 'Existing document', role: 'plaintiff',
        focus: '', createdAt: '2026-11-03', paragraphIds: ['paragraph'],
        paragraphs: [{ id: 'paragraph', text: 'Original document.', richText: '<p><u>Original document.</u></p>', links: [], references: [] }] }]
      await writeWorkspace(workspace)
    })
    const { createApp } = await import(pathToFileURL(path.join(serverRoot, 'app.js')).href)
    server = createApp().app.listen(8787, '127.0.0.1')
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    window = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { backgroundThrottling: false } })
    window.webContents.on('console-message', event => messages.push(event.message))
    const evaluate = code => window.webContents.executeJavaScript(code)
    const wait = async expression => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${expression})`)) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error(`Timeout: ${expression}`)
    }
    await window.loadURL('http://127.0.0.1:8787')
    await evaluate("sessionStorage.setItem('lawverify-auth-session','isolated-ui-session');sessionStorage.setItem('lawverify-login-account','case-ui@test.invalid');location.reload()")
    await wait("document.querySelector('button[aria-label=\"\\u65b0\\u5efa\\u6848\\u4ef6\"]')")
    await wait("document.querySelector('.tiptap-editor-body u')?.textContent === 'Original document.'")
    await evaluate("window.alert = message => {window.lastAlert=message};document.querySelector('button[aria-label=\"\\u65b0\\u5efa\\u6848\\u4ef6\"]').click()")
    await wait("document.querySelector('.case-dialog input')")
    const fill = value => evaluate(`(() => {
      const input=document.querySelector('.case-dialog input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`)
    await fill('Created in browser')
    await evaluate("document.querySelector('.case-dialog .primary-button').click()")
    await wait("!document.querySelector('.case-dialog') && document.body.textContent.includes('Created in browser')")
    await evaluate("document.querySelector('button[aria-label=\"\\u91cd\\u547d\\u540d\\uff1aCreated in browser\"]').click()")
    await wait("document.querySelector('.case-dialog input')")
    await fill('Renamed in browser')
    await evaluate("document.querySelector('.case-dialog .primary-button').click()")
    await wait("!document.querySelector('.case-dialog') && document.body.textContent.includes('Renamed in browser')")
    assert.equal(await evaluate('window.lastAlert'), undefined)
    await runWithWorkspaceAccount('case-ui@test.invalid', async () => {
      const saved = await readWorkspace()
      assert.equal(saved.cases[0].name, 'Renamed in browser')
      assert.equal(saved.certificates[0].paragraphs[0].text, 'Original document.')
      assert.equal(saved.certificates[0].paragraphs[0].richText, '<p><u>Original document.</u></p>')
    })
    assert.equal(messages.some(message => /Duplicate extension names|7777\/event/.test(message)), false)
    process.stdout.write('PASS: rendered app creates and renames cases, persists names, preserves document and underline, and emits no duplicate-extension/debug-event warning.\n')
    window.destroy()
    await new Promise(resolve => server.close(resolve))
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack}\n`)
    window?.destroy()
    server?.close()
    app.exit(1)
  }
})
process.on('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true }) } catch {} })
