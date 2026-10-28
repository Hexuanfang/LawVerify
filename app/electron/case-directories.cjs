const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const allowed = /\.(pdf|docx|doc|rtf|txt|md|png|jpe?g|gif|webp|pptx?)$/i
const fingerprint = metadata => `stat:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`

function registerCaseDirectories({ app, ipcMain, dialog, BrowserWindow }) {
  const configPath = path.join(app.getPath('userData'), 'case-directories.json')
  let config = {}
  let pendingSave = Promise.resolve()
  const ready = fs.readFile(configPath, 'utf8').then(raw => { config = JSON.parse(raw) }).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  const keyFor = ({ account, caseId }) => {
    if (typeof account !== 'string' || !account.trim() || typeof caseId !== 'string' || !caseId.trim()) {
      throw new Error('请先登录并选择案件。')
    }
    return JSON.stringify([account.trim().toLowerCase(), caseId])
  }
  const save = () => {
    const raw = JSON.stringify(config)
    pendingSave = pendingSave.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      const temporary = `${configPath}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, raw, { encoding: 'utf8', flag: 'wx' })
      await fs.rename(temporary, configPath)
    })
    return pendingSave
  }
  const scan = async (directory, onBatch) => {
    const files = []
    let batch = []
    let lastSent = Date.now()
    let firstBatch = true
    const publish = done => {
      if (!onBatch || !batch.length && !done) return
      onBatch({ id: directory.id, name: directory.name, files: batch, completed: files.length, done })
      batch = []
      firstBatch = false
      lastSent = Date.now()
    }
    const rootStat = await fs.lstat(directory.path)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('链接目录已不可访问，请重新链接。')
    const folders = [{ current: directory.path, relative: '' }]
    for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
      const { current, relative } = folders[folderIndex]
      const entries = await fs.readdir(current, { withFileTypes: true })
      const candidates = []
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name.startsWith('~$')) continue
        const child = path.join(current, entry.name)
        const nextRelative = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) folders.push({ current: child, relative: nextRelative })
        else if (entry.isFile() && allowed.test(entry.name)) {
          candidates.push({ child, relativePath: nextRelative, fileName: entry.name })
        }
      }
      // Bound filesystem concurrency and publish early without reading file contents.
      for (let offset = 0; offset < candidates.length; offset += 16) {
        const items = await Promise.all(candidates.slice(offset, offset + 16).map(async item => {
          const metadata = await fs.stat(item.child)
          if (metadata.size > 100 * 1024 * 1024) throw new Error(`文件“${item.fileName}”超过100MB，请拆分后再同步。`)
          return { relativePath: item.relativePath, fileName: item.fileName, size: metadata.size,
            hash: fingerprint(metadata) }
        }))
        files.push(...items)
        batch.push(...items)
        if (batch.length >= (firstBatch ? 32 : 128) || Date.now() - lastSent >= 50) publish(false)
      }
    }
    publish(true)
    return { id: directory.id, name: directory.name, files }
  }
  ipcMain.handle('lawverify:case-directories-link', async (event, payload) => {
    const key = keyFor(payload)
    const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      properties: ['openDirectory'], title: '链接案件材料目录',
    })
    if (selected.canceled) return null
    await ready
    const realPath = await fs.realpath(selected.filePaths[0])
    const directories = config[key] ?? []
    let directory = directories.find(item => item.path.toLowerCase() === realPath.toLowerCase())
    if (!directory) {
      directory = { id: randomUUID(), name: path.basename(realPath), path: realPath }
      config[key] = [...directories, directory]
      await save()
    }
    return scan(directory, payload.requestId ? batch => {
      if (!event.sender.isDestroyed?.()) {
        event.sender.send('lawverify:case-directories-batch', {
          ...batch, requestId: payload.requestId, account: payload.account.trim().toLowerCase(), caseId: payload.caseId,
        })
      }
    } : undefined)
  })
  ipcMain.handle('lawverify:case-directories-scan', async (_event, payload) => {
    await ready
    const directories = config[keyFor(payload)] ?? []
    const results = []
    for (const directory of directories) results.push(await scan(directory))
    return results
  })
  ipcMain.handle('lawverify:case-directories-clear', async (_event, payload) => {
    await ready
    const key = keyFor(payload)
    delete config[key]
    await save()
    return { ok: true }
  })
  ipcMain.handle('lawverify:case-directories-read', async (_event, payload) => {
    await ready
    const directory = (config[keyFor(payload)] ?? []).find(item => item.id === payload.directoryId)
    if (!directory || typeof payload.relativePath !== 'string') throw new Error('材料目录未授权。')
    const root = await fs.realpath(directory.path)
    const target = await fs.realpath(path.resolve(root, payload.relativePath))
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !allowed.test(target)) {
      throw new Error('材料不在已授权目录内。')
    }
    const metadata = await fs.stat(target)
    if (!metadata.isFile() || metadata.size > 100 * 1024 * 1024) throw new Error('材料格式或大小不受支持。')
    const metadataOnly = payload.hash?.startsWith('stat:')
    if (metadataOnly && fingerprint(metadata) !== payload.hash) throw new Error('材料已变化，正在重新同步。')
    const bytes = await fs.readFile(target)
    const after = await fs.stat(target)
    if (fingerprint(metadata) !== fingerprint(after)
      || !metadataOnly && createHash('sha256').update(bytes).digest('hex') !== payload.hash) {
      throw new Error('材料已变化，正在重新同步。')
    }
    return new Uint8Array(bytes)
  })
}

module.exports = { registerCaseDirectories }
