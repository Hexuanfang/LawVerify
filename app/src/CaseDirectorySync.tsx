import { useEffect, useRef } from 'react'
import { api } from './api'
import type { AppState } from './types'

const syncing = new Map<string, Promise<AppState>>()
const clearedCases = new Set<string>()
const scopeKey = (account: string, caseId: string) => JSON.stringify([account.trim().toLowerCase(), caseId])

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
  for (const [index, item] of directory.files.entries()) {
    if (!stillAuthorized()) return current
    const relativePath = `${directory.name}--${directory.id}/${item.relativePath}`
    const existing = indexed.get(relativePath)
    if (existing?.sourceFingerprint === item.hash && existing.storageKey) {
      onProgress?.(index + 1, directory.files.length)
      continue
    }
    const bytes = await window.lawVerifyDesktop!.readCaseDirectoryFile!({
      account, caseId, directoryId: directory.id, relativePath: item.relativePath, hash: item.hash,
    })
    const file = new File([bytes], item.fileName) as File & { webkitRelativePath: string }
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
    const { assets } = await api.uploadEvidenceSourceFiles([file])
    const asset = assets[0]
    if (!asset) throw new Error(`文件“${item.fileName}”同步失败。`)
    if (!stillAuthorized()) return current
    await api.syncDirectoryEvidences({
      caseId, processInBackground: false, deferUnderstanding: true,
      files: [{ ...asset, fileName: item.fileName, relativePath, directoryId: directory.id, sourceFingerprint: item.hash,
        name: item.fileName, type: 'other', ocrText: '' }],
    })
    onProgress?.(index + 1, directory.files.length)
  }
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
      if (running || !active) return
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
    const timer = window.setInterval(() => void scan(), 20000)
    window.addEventListener('focus', scan)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', scan) }
  }, [account, caseId, enabled])
  return null
}
