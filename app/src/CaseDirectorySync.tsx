import { useEffect, useRef } from 'react'
import { api } from './api'
import { resolveEvidenceMimeType } from './evidence-mime'
import type { AppState } from './types'

const syncing = new Map<string, Promise<AppState>>()
const clearedCases = new Set<string>()
const scopeKey = (account: string, caseId: string) => JSON.stringify([account.trim().toLowerCase(), caseId])
// 单批上传的字节数与文件数上限：批次越小，越早进入后台解析与理解。
const MAX_UPLOAD_BATCH_BYTES = 48_000_000
const MAX_UPLOAD_BATCH_COUNT = 16

export async function stopCaseDirectorySync(account: string, caseId: string) {
  clearedCases.add(scopeKey(account, caseId))
  await Promise.allSettled([...syncing.entries()]
    .filter(([key]) => {
      const [owner, folder] = JSON.parse(key)
      return scopeKey(owner, folder) === scopeKey(account, caseId)
    }).map(([, task]) => task))
}

export function resumeCaseDirectorySync(account: string, caseId: string) {
  clearedCases.delete(scopeKey(account, caseId))
}

export function syncDesktopDirectory(account: string, caseId: string, directory: CaseDirectoryManifest, active: () => boolean = () => true, onProgress?: (completed: number, total: number) => void, onLinked?: (workspace: AppState) => void): Promise<AppState> {
  const key = JSON.stringify([account, caseId, directory.id])
  onProgress?.(0, directory.files.length)
  const existing = syncing.get(key)
  if (existing) return existing.then(() =>
    syncDesktopDirectory(account, caseId, directory, active, onProgress, onLinked),
  )
  const task = syncDirectory(account, caseId, directory, active, onProgress, onLinked).finally(() => syncing.delete(key))
  syncing.set(key, task)
  return task
}

async function syncDirectory(account: string, caseId: string, directory: CaseDirectoryManifest, active: () => boolean, onProgress?: (completed: number, total: number) => void, onLinked?: (workspace: AppState) => void) {
  const stillAuthorized = () => active()
    && !clearedCases.has(scopeKey(account, caseId))
    && sessionStorage.getItem('lawverify-login-account')?.trim().toLowerCase() === account.trim().toLowerCase()
  let current = (await api.getWorkspace()).workspace
  if (!stillAuthorized()) return current
  const indexFor = (workspace: AppState) => new Map(workspace.evidences
    .filter(e => e.caseId === caseId && e.directoryId === directory.id)
    .map(e => [e.relativePath, e]))
  let indexed = indexFor(current)
  const needsUnderstanding = directory.files.some(item => {
    const existing = indexed.get(`${directory.name}--${directory.id}/${item.relativePath}`)
    return !existing || existing.sourceFingerprint !== item.hash || !existing.storageKey || existing.summaryStatus === 'idle'
  })
  // Register the entire directory before reading or uploading any original.
  for (let offset = 0; offset < directory.files.length; offset += 200) {
    if (!stillAuthorized()) return current
    await api.syncDirectoryEvidences({
      caseId, processInBackground: false, deferUnderstanding: true,
      files: directory.files.slice(offset, offset + 200).map(item => ({
        fileName: item.fileName, relativePath: `${directory.name}--${directory.id}/${item.relativePath}`,
        directoryId: directory.id, sourceFingerprint: item.hash, name: item.fileName, type: 'other', ocrText: '',
      })),
    })
  }
  current = (await api.getWorkspace()).workspace
  indexed = indexFor(current)
  if (!stillAuthorized()) return current
  onLinked?.(current)
  // 批量上传：读完一批就上传并登记，登记后立即进入后台解析与理解，不等整个目录传完。
  let batch: Array<{ file: File & { webkitRelativePath: string }; item: CaseDirectoryManifest['files'][number] }> = []
  let batchBytes = 0
  let completed = 0
  const flushBatch = async () => {
    if (!batch.length) {
      return
    }
    const pending = batch
    batch = []
    batchBytes = 0
    const { assets } = await api.uploadEvidenceSourceFiles(pending.map((entry) => entry.file))
    if (!stillAuthorized()) return current
    await api.syncDirectoryEvidences({
      caseId, processInBackground: true,
      files: pending.map((entry, index) => {
        const asset = assets[index]
        if (!asset) throw new Error(`文件“${entry.item.fileName}”同步失败。`)
        return {
          ...asset,
          fileName: entry.item.fileName,
          relativePath: entry.file.webkitRelativePath,
          directoryId: directory.id,
          sourceFingerprint: entry.item.hash,
          name: entry.item.fileName,
          type: 'other' as const,
          ocrText: '',
        }
      }),
    })
    completed += pending.length
    onProgress?.(completed, directory.files.length)
  }

  for (const item of directory.files) {
    if (!stillAuthorized()) return current
    const relativePath = `${directory.name}--${directory.id}/${item.relativePath}`
    const existing = indexed.get(relativePath)
    if (existing?.sourceFingerprint === item.hash && existing.storageKey) {
      completed += 1
      onProgress?.(completed, directory.files.length)
      continue
    }
    const bytes = await window.lawVerifyDesktop!.readCaseDirectoryFile!({
      account, caseId, directoryId: directory.id, relativePath: item.relativePath, hash: item.hash,
    })
    const file = new File([bytes], item.fileName, {
      type: resolveEvidenceMimeType(item.fileName),
    }) as File & { webkitRelativePath: string }
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
    batch.push({ file, item })
    batchBytes += bytes.byteLength
    if (batch.length >= MAX_UPLOAD_BATCH_COUNT || batchBytes >= MAX_UPLOAD_BATCH_BYTES) {
      await flushBatch()
    }
  }
  await flushBatch()
  const paths = new Set(directory.files.map(item => `${directory.name}--${directory.id}/${item.relativePath}`))
  for (const removed of current.evidences.filter(e => e.caseId === caseId && e.directoryId === directory.id
    && !paths.has(e.relativePath ?? ''))) {
    if (!stillAuthorized()) return current
    await api.deleteDirectoryEvidence(removed.id)
  }
  if (!stillAuthorized()) return current
  if (needsUnderstanding && current.cases.find(c => c.id === caseId)?.agent?.autoAnalyze !== false) {
    return (await api.retryCaseAgent(caseId)).workspace
  }
  return (await api.getWorkspace()).workspace
}

export function CaseDirectorySync({ account, caseId, enabled, onWorkspace, onError }: {
  account: string
  caseId: string
  enabled: boolean
  onWorkspace: (workspace: AppState) => void
  onError: (message: string) => void
}) {
  const handlers = useRef({ onWorkspace, onError })
  useEffect(() => { handlers.current = { onWorkspace, onError } }, [onWorkspace, onError])
  useEffect(() => {
    if (!enabled || !window.lawVerifyDesktop?.scanCaseDirectories) return
    let active = true
    let running = false
    const scan = async () => {
      if (running || !active || document.visibilityState === 'hidden') return
      running = true
      try {
        const directories = await window.lawVerifyDesktop!.scanCaseDirectories!({ account, caseId })
        for (const directory of directories) {
          if (!active) break
          const workspace = await syncDesktopDirectory(account, caseId, directory, () => active)
          if (active) handlers.current.onWorkspace(workspace)
        }
      } catch (error) {
        if (active) handlers.current.onError(error instanceof Error ? error.message : '目录同步失败，请检查原件。')
      } finally { running = false }
    }
    void scan()
    const timer = window.setInterval(() => void scan(), 60000)
    const visible = () => { if (document.visibilityState === 'visible') void scan() }
    window.addEventListener('focus', scan)
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', scan)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [account, caseId, enabled])
  return null
}
