const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const allowed = /\.(pdf|docx?|rtf|txt|md|markdown|csv|png|jpe?g|gif|webp|pptx?)$/i
const fingerprint = metadata => `stat:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
// 单个材料原件的大小上限：与服务端 MAX_EVIDENCE_FILE_MB 保持一致。
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_PENDING_LINKS = 128

function registerCaseDirectories({ app, ipcMain, dialog, BrowserWindow }) {
  const configPath = path.join(app.getPath('userData'), 'case-directories.json')
  const selections = new WeakMap()
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
  const chooseDirectory = async event => {
    const options = {
      properties: ['openDirectory'], title: '链接案件材料目录',
    }
    const selected = event
      ? await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), options)
      : await dialog.showOpenDialog(options)
    if (selected.canceled) return null
    return fs.realpath(selected.filePaths[0])
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
    if (directory.kind === 'file') {
      const metadata = await fs.lstat(directory.path).catch(error => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
        return null
      })
      if (!metadata?.isFile() || !samePath(await fs.realpath(directory.path), directory.path)) {
        throw new Error(`材料「${directory.name}」已不可访问，请重新链接。`)
      }
      if (!allowed.test(directory.name) || metadata.size > MAX_FILE_BYTES) throw new Error('材料格式或大小不受支持。')
      return { id: directory.id, name: directory.name, kind: 'file', files: [{ relativePath: directory.name,
        fileName: directory.name, size: metadata.size, hash: fingerprint(metadata) }] }
    }
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
          if (metadata.size > MAX_FILE_BYTES) throw new Error(`文件“${item.fileName}”超过${MAX_FILE_BYTES / 1024 / 1024}MB，请拆分后再导入。`)
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
  // 仅回收操作开始前已存在且未保留的条目，防止选择目录和拖放相互覆盖。
  const reusableSelections = (event, retained) => [...(selections.get(event.sender)?.keys() ?? [])]
    .filter(id => !retained.has(id))
  const stage = async (event, owner, realPath, kind, retained, reusableIds) => {
    const candidate = { id: randomUUID(), owner, name: path.basename(realPath), path: realPath, kind }
    const count = (await scan(candidate)).files.length
    if (!count) throw new Error('文件夹内没有可导入的案件原材料。')
    let pending = selections.get(event.sender)
    if (!pending) selections.set(event.sender, pending = new Map())
    const existing = [...pending.values()].find(item => (!item.caseKey || retained.has(item.id)) && item.owner === owner &&
      item.kind === kind && samePath(item.path, realPath))
    const selected = existing ?? candidate
    if (!existing) {
      if (pending.size >= MAX_PENDING_LINKS) {
        const reusable = reusableIds.find(id => pending.has(id) && !retained.has(id))
        if (!reusable) throw new Error(`最多可待链接 ${MAX_PENDING_LINKS} 项材料，请先移除一项。`)
        pending.delete(reusable)
      }
      pending.set(selected.id, selected)
    }
    return { id: selected.id, name: selected.name, kind, count }
  }
  ipcMain.handle('lawverify:case-directories-pick', async (event, { account, retainIds = [] }) => {
    const owner = keyFor({ account, caseId: 'pending' })
    const retained = new Set(retainIds)
    const reusableIds = reusableSelections(event, retained)
    // 独立打开目录选择框，让应用窗口在选目录期间仍能接收拖放。
    const realPath = await chooseDirectory()
    return realPath ? stage(event, owner, realPath, 'directory', retained, reusableIds) : null
  })
  ipcMain.handle('lawverify:case-directories-stage-drop', async (event, { account, paths, retainIds = [] }) => {
    const owner = keyFor({ account, caseId: 'pending' })
    if (!Array.isArray(paths) || paths.length > MAX_PENDING_LINKS) throw new Error(`一次最多拖入 ${MAX_PENDING_LINKS} 个文件或文件夹。`)
    const retained = new Set(retainIds)
    const reusableIds = reusableSelections(event, retained)
    const links = new Map()
    let skipped = 0
    for (const dropped of new Set(paths)) {
      try {
        if (typeof dropped !== 'string' || !path.isAbsolute(dropped)) throw new Error('无效的本地材料位置。')
        const realPath = await fs.realpath(dropped)
        const metadata = await fs.lstat(realPath)
        if (!metadata.isDirectory() && !metadata.isFile()) throw new Error('材料类型不受支持。')
        const link = await stage(event, owner, realPath, metadata.isDirectory() ? 'directory' : 'file', retained, reusableIds)
        links.set(link.id, link)
        retained.add(link.id)
      } catch {
        skipped++
      }
    }
    return { links: [...links.values()], skipped }
  })
  ipcMain.handle('lawverify:case-directories-attach', async (event, payload) => {
    await ready
    const key = keyFor(payload)
    const pending = selections.get(event.sender)
    const selected = pending?.get(payload.selectionId)
    const directories = config[key] ?? []
    let directory = directories.find(item => item.id === payload.selectionId)
    if (selected?.owner === keyFor({ account: payload.account, caseId: 'pending' }) && (!selected.caseKey || selected.caseKey === key)) {
      const manifest = await scan(selected)
      if (!manifest.files.length) throw new Error('文件夹内没有可导入的案件原材料。')
      if (selected.caseKey && selected.caseKey !== key) throw new Error('材料链接未授权，请重新选择。')
      selected.caseKey = key
      const current = config[key] ?? []
      directory = current.find(item => (item.kind ?? 'directory') === selected.kind && samePath(item.path, selected.path))
      if (!directory) {
        directory = { id: selected.id, name: selected.name, path: selected.path, ...(selected.kind === 'file' ? { kind: 'file' } : {}) }
        config[key] = [...current, directory]
      }
      await save()
      if (directory.id === selected.id) pending.delete(selected.id)
      return { ...manifest, id: directory.id }
    }
    if (!directory) throw new Error('材料目录未授权，请重新选择。')
    return scan(directory)
  })
  ipcMain.handle('lawverify:case-directories-link', async (event, payload) => {
    const key = keyFor(payload)
    const realPath = await chooseDirectory(event)
    if (!realPath) return null
    await ready
    const directories = config[key] ?? []
    let directory = directories.find(item => item.kind !== 'file' && samePath(item.path, realPath))
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
    for (const directory of directories) {
      try { results.push(await scan(directory)) }
      catch (error) {
        if (directory.kind !== 'file') throw error
        results.push({ id: directory.id, name: directory.name, kind: 'file', files: [], unavailable: true })
      }
    }
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
    let target
    if (directory.kind === 'file') {
      if (payload.relativePath !== directory.name) throw new Error('材料文件未授权。')
      target = await fs.realpath(directory.path)
      if (!samePath(target, directory.path)) throw new Error('材料文件未授权，请重新链接。')
    } else {
      const root = await fs.realpath(directory.path)
      target = await fs.realpath(path.resolve(root, payload.relativePath))
      const relative = path.relative(root, target)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('材料不在已授权目录内。')
    }
    const metadata = await fs.stat(target)
    if (!allowed.test(target) || !metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw new Error('材料格式或大小不受支持。')
    const metadataOnly = payload.hash?.startsWith('stat:')
    if (metadataOnly && fingerprint(metadata) !== payload.hash) throw new Error('材料已变化，请重新导入。')
    const bytes = await fs.readFile(target)
    const after = await fs.stat(target)
    if (fingerprint(metadata) !== fingerprint(after)
      || !metadataOnly && createHash('sha256').update(bytes).digest('hex') !== payload.hash) {
      throw new Error('材料已变化，请重新导入。')
    }
    return new Uint8Array(bytes)
  })
}

module.exports = { registerCaseDirectories }
