const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { registerCaseDirectories } = require('./case-directories.cjs')

test('folder picker opens without waiting for directory configuration or reading materials', async () => {
  const readFile = fs.readFile
  let finishConfig
  const pendingConfig = new Promise(resolve => { finishConfig = resolve })
  const handlers = new Map()
  let pickerOpened = false
  fs.readFile = () => pendingConfig
  try {
    registerCaseDirectories({
      app: { getPath: () => os.tmpdir() },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      dialog: { showOpenDialog: async () => {
        pickerOpened = true
        return { canceled: true, filePaths: [] }
      } },
      BrowserWindow: { fromWebContents: () => null },
    })
    const result = handlers.get('lawverify:case-directories-link')(
      { sender: {} }, { account: 'owner@test.invalid', caseId: 'case-one' },
    )
    assert.equal(pickerOpened, true, 'picker must open immediately, before configuration is ready')
    assert.equal(await result, null, 'cancel must not wait for configuration or start scanning')
  } finally {
    finishConfig('{}')
    fs.readFile = readFile
  }
})

test('directory consent, restart, content hashes, deletions and path containment', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lawverify-directory-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const material = path.join(root, 'materials')
  await fs.mkdir(material)
  await fs.mkdir(path.join(material, 'nested'))
  await fs.writeFile(path.join(material, 'nested', '01_evidence.txt'), 'original')
  await fs.writeFile(path.join(material, 'ignored.exe'), 'not evidence')
  const handlers = new Map()
  const dependencies = {
    app: { getPath: () => root },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [material] }) },
    BrowserWindow: { fromWebContents: () => null },
  }
  registerCaseDirectories(dependencies)
  const invoke = (name, payload) => handlers.get(`lawverify:case-directories-${name}`)({ sender: {} }, payload)
  const scope = { account: 'owner@test.invalid', caseId: 'case-one' }
  const readFile = fs.readFile
  const originalReads = []
  fs.readFile = async (file, ...args) => {
    if (String(file).startsWith(material)) originalReads.push(file)
    return readFile(file, ...args)
  }
  let linked
  try {
    linked = await invoke('link', scope)
  } finally {
    fs.readFile = readFile
  }
  assert.equal(originalReads.length, 0, 'linking must not read any original contents')
  assert.match(linked.files[0].hash, /^stat:/, 'listing uses metadata, not a content hash')
  assert.equal(linked.files.length, 1)
  assert.equal(linked.files[0].relativePath, 'nested/01_evidence.txt')
  const again = await invoke('link', scope)
  assert.equal(again.id, linked.id)
  assert.deepEqual(await invoke('scan', { ...scope, account: 'other@test.invalid' }), [])
  const request = { ...scope, directoryId: linked.id, relativePath: linked.files[0].relativePath, hash: linked.files[0].hash }
  assert.equal(Buffer.from(await invoke('read', request)).toString(), 'original')
  await assert.rejects(invoke('read', { ...request, relativePath: '../../outside.txt' }))
  await fs.writeFile(path.join(material, 'nested', '01_evidence.txt'), 'changed')
  const changed = (await invoke('scan', scope))[0]
  assert.notEqual(changed.files[0].hash, linked.files[0].hash)
  await assert.rejects(invoke('read', request), /材料已变化/)
  await fs.writeFile(path.join(material, '02_evidence.txt'), 'new material')
  assert.equal((await invoke('scan', scope))[0].files.length, 2)
  registerCaseDirectories(dependencies)
  assert.equal((await invoke('scan', scope))[0].id, linked.id, 'directory consent must survive restart')
  await fs.unlink(path.join(material, 'nested', '01_evidence.txt'))
  assert.equal((await invoke('scan', scope))[0].files.length, 1)
  await fs.rename(material, `${material}-offline`)
  await assert.rejects(invoke('scan', scope), /ENOENT/)
  const otherScope = { ...scope, caseId: 'other-case' }
  await fs.rename(`${material}-offline`, material)
  await invoke('link', otherScope)
  await invoke('clear', scope)
  assert.deepEqual(await invoke('scan', scope), [])
  assert.equal((await invoke('scan', otherScope)).length, 1, 'clearing must only affect the selected case')
  assert.equal(await fs.readFile(path.join(material, '02_evidence.txt'), 'utf8'), 'new material')
  await assert.rejects(invoke('read', request), /未授权/)
  registerCaseDirectories(dependencies)
  assert.deepEqual(await invoke('scan', scope), [], 'clearing must persist across restarts')
  assert.equal((await invoke('link', scope)).files.length, 1, 'cleared directories can be linked again')
})

test('directory batches arrive before scanning finishes and allow immediate original reads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lawverify-stream-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const materials = path.join(root, 'materials')
  await fs.mkdir(path.join(materials, 'nested', 'deeper'), { recursive: true })
  await Promise.all(Array.from({ length: 320 }, (_, i) =>
    fs.writeFile(path.join(i < 160 ? materials : path.join(materials, 'nested', 'deeper'), `${i}.txt`), `Original ${i}`),
  ))
  const handlers = new Map()
  const batches = []
  let finished = false
  let preview
  const scope = { account: 'owner@test.invalid', caseId: 'stream-case', requestId: 'stream-request' }
  registerCaseDirectories({
    app: { getPath: () => root },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [materials] }) },
    BrowserWindow: { fromWebContents: () => null },
  })
  const manifest = await handlers.get('lawverify:case-directories-link')({
    sender: {
      isDestroyed: () => false,
      send: (channel, batch) => {
        assert.equal(channel, 'lawverify:case-directories-batch')
        assert.equal(batch.requestId, scope.requestId)
        assert.equal(batch.caseId, scope.caseId)
        assert.equal(batch.account, scope.account)
        assert.equal(finished, false)
        batches.push(batch)
        if (!preview) {
          const item = batch.files[0]
          preview = handlers.get('lawverify:case-directories-read')({}, {
            ...scope, directoryId: batch.id, relativePath: item.relativePath, hash: item.hash,
          })
        }
      },
    },
  }, scope)
  finished = true
  assert.equal(manifest.files.length, 320)
  assert.ok(batches.length > 1)
  assert.ok(batches[0].files.length <= 48, 'first batch must not wait for the entire folder')
  assert.equal(batches.at(-1).done, true)
  assert.equal(batches.at(-1).completed, 320)
  assert.deepEqual(batches.flatMap(b => b.files), manifest.files, 'all files must arrive once and in order')
  assert.match(Buffer.from(await preview).toString(), /^Original /)
})
