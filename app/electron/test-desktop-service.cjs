const { app, BrowserWindow, utilityProcess } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ServiceSupervisor } = require('./service-supervisor.cjs')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-service-test-'))
app.setPath('userData', directory)
let supervisor
app.whenReady().then(async () => {
  const port = 18787
  const env = {
    ...process.env, NODE_ENV: 'production', PORT: String(port), LAWVERIFY_DESKTOP: '1',
    APP_RUNTIME_ROOT: path.resolve(__dirname, '../.desktop/server'),
    APP_DATA_ROOT: directory, WORKSPACE_DATA_DIR: path.join(directory, 'data'),
    STORAGE_LOCAL_ROOT: path.join(directory, 'storage'),
    FRONTEND_DIST_DIR: path.resolve(__dirname, '../dist'),
    CORS_ORIGIN: `http://127.0.0.1:${port}`, AUTO_RUN_MIGRATIONS: 'false',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const origin = `http://127.0.0.1:${port}`
  const readyAgain = () => new Promise(resolve => {
    const listener = ({ state }) => { if (state === 'ready') { supervisor.off('status', listener); resolve() } }
    supervisor.on('status', listener)
  })
  const json = async (url, init) => {
    const response = await fetch(`${origin}${url}`, { ...init, signal: AbortSignal.timeout(5000) })
    assert.ok(response.ok, `HTTP ${response.status}`)
    return response.json()
  }
  const window = new BrowserWindow({ show: false })
  try {
    supervisor = new ServiceSupervisor({
      fork: (...args) => utilityProcess.fork(...args), entry: path.join(__dirname, 'desktop-service.cjs'),
      env, restartDelays: [100, 100, 100],
    })
    await supervisor.waitUntilReady()
    assert.equal((await json('/api/health')).ok, true)
    await window.loadURL(origin)
    const created = await json('/api/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Isolated service verification"}' })
    const caseId = created.workspace.cases.find(item => item.name === 'Isolated service verification').id
    const backupDirectory = path.join(directory, 'data', 'workspace-backups')
    const backupDeadline = Date.now() + 10000
    while (!fs.existsSync(backupDirectory) || !fs.readdirSync(backupDirectory).some(file => file.endsWith('.sqlite'))) {
      if (Date.now() > backupDeadline) throw new Error('Desktop snapshot was not produced')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.notEqual(supervisor.child.pid, process.pid)
    const restarted = readyAgain()
    supervisor.child.kill()
    assert.equal(await window.webContents.executeJavaScript('1 + 1'), 2)
    await restarted
    const workspace = await json('/api/workspace')
    assert.ok(workspace.workspace.cases.some(item => item.id === caseId))
    // Verify that the isolated utility process can itself spawn the native parser.
    const word = require('docx')
    const buffer = await word.Packer.toBuffer(new word.Document({ sections: [{ children: [new word.Paragraph('Desktop parser')] }] }))
    const form = new FormData()
    form.append('files', new Blob([buffer]), 'fixture.docx')
    const upload = await json('/api/v1/knowledge/files/upload', { method: 'POST', body: form })
    assert.ok(JSON.stringify(upload).includes('Desktop parser'))
    const failed = new Promise(resolve => {
      const listener = ({ state }) => { if (state === 'failed') { supervisor.off('status', listener); resolve() } }
      supervisor.on('status', listener)
    })
    for (let index = 0; index < 2; index++) {
      const ready = readyAgain()
      supervisor.child.kill()
      await ready
    }
    supervisor.child.kill()
    await failed
    assert.equal(await window.webContents.executeJavaScript('2 + 2'), 4)
    supervisor.stop()
    window.destroy()
    process.stdout.write('Desktop service: isolated process, verified snapshot, persistent data after kill, native parser child, restart budget and responsive renderer passed\n')
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack}\n`)
    supervisor?.stop()
    app.exit(1)
  }
})
process.on('exit', () => {
  try { fs.rmSync(directory, { recursive: true, force: true }) } catch {}
})
