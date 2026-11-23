import { api } from '../api'
import { resumeCaseDirectorySync, syncDesktopDirectory } from '../CaseDirectorySync'
import type { CasePositionDraft } from '../types'
import { importDocument } from './services'

const MAX_BATCH_BYTES = 48_000_000
const MAX_BATCH_FILES = 16
const materialWaitLimit = 20 * 60_000

export function prepareEvidenceUpload(caseId: string, imported = new Set<File>()) {
  return async (files: File[], check: () => void, report?: (message: string) => void) => {
    const pending = files.filter(file => !imported.has(file))
    let offset = 0
    while (offset < pending.length) {
      check()
      const batch = [pending[offset]]
      let size = batch[0].size
      while (batch.length < MAX_BATCH_FILES && offset + batch.length < pending.length) {
        const next = pending[offset + batch.length]
        if (size + next.size > MAX_BATCH_BYTES) break
        batch.push(next)
        size += next.size
      }
      const first = files.length - pending.length + offset + 1
      const message = `正在上传案件原材料 ${first}–${first + batch.length - 1}/${files.length}`
      report?.(message)
      const { assets } = await api.uploadEvidenceSourceFilesWithProgress(batch, report ? (loaded, total) => {
        if (total) report(`${message} · ${Math.round(loaded / total * 100)}%`)
      } : undefined, caseId)
      check()
      if (assets.length !== batch.length) throw new Error('部分案件原材料上传失败，请重试。')
      await api.importEvidences({ caseId, processInBackground: true,
        files: assets.map(asset => ({ ...asset, name: asset.fileName, type: 'other', ocrText: '' })),
      })
      batch.forEach(file => imported.add(file))
      offset += batch.length
    }
  }
}

export function prepareMaterialLinks(account: string, caseId: string, synced = new Set<string>()) {
  return async (links: CaseMaterialSelection[], check: () => void, active: () => boolean, report?: (message: string) => void) => {
    for (const link of links) {
      check()
      if (synced.has(link.id)) continue
      report?.(`正在链接案件原材料 · ${link.name}`)
      const manifest = await window.lawVerifyDesktop!.attachCaseDirectory!({ account, caseId, selectionId: link.id })
      check()
      if (!manifest.files.length) throw new Error(`文件夹「${link.name}」内没有可导入的案件原材料，请补充文件后重试。`)
      resumeCaseDirectorySync(account, caseId)
      await syncDesktopDirectory(account, caseId, manifest, active, report ? (completed, total) => {
        if (active()) report(`正在导入案件原材料 · ${link.name} · ${completed}/${total}`)
      } : undefined)
      check()
      synced.add(link.id)
    }
  }
}

export function prepareCaseFiles({ caseId, name, files, documents, links, position }: {
  caseId: string
  name: string
  files: File[]
  documents: File[]
  links: CaseMaterialSelection[]
  position?: CasePositionDraft
}) {
  const account = sessionStorage.getItem('lawverify-login-account') || ''
  const session = sessionStorage.getItem('lawverify-auth-session')
  const currentSession = () => account === sessionStorage.getItem('lawverify-login-account') &&
    session === sessionStorage.getItem('lawverify-auth-session')
  const imported = new Map<File, string>()
  const linkMaterials = prepareMaterialLinks(account, caseId)
  const uploadEvidence = prepareEvidenceUpload(caseId)
  let positionSaved = false
  return async (signal: AbortSignal, report: (message: string, title: string) => void) => {
    const check = () => {
      signal.throwIfAborted()
      if (!currentSession()) throw new Error('当前登录账号已变化，请重新打开页面。')
    }
    check()
    if (position && !positionSaved) {
      report('正在保存代理立场', name)
      const workspace = (await api.getWorkspace(signal)).workspace
      check()
      const version = workspace.cases.find(item => item.id === caseId)?.agent?.position?.version ?? 0
      await api.confirmCasePosition(caseId, position, version)
      positionSaved = true
    }
    const active = () => !signal.aborted && currentSession()
    const reportMaterial = documents.length ? undefined : (message: string) => { if (active()) report(message, name) }
    if (documents.length) report('正在链接案件原材料', name)
    await uploadEvidence(files, check, reportMaterial)
    await linkMaterials(links, check, active, reportMaterial)
    const parseOrder = [...documents].sort((left, right) => left.size - right.size)
    for (const [index, file] of parseOrder.entries()) {
      check()
      if (imported.has(file)) continue
      const title = file.name.replace(/\.[^.]+$/, '')
      // 由服务端在原材料解析完成后推进核验阶段。
      report(`正在解析第 ${index + 1}/${documents.length} 份文书 · ${file.name}`, title)
      const saved = await importDocument(caseId, file, signal)
      const id = saved.certificate?.id
      if (!id || Array.from(imported.values()).includes(id)) {
        throw new Error(`文书「${file.webkitRelativePath || file.name}」未取得独立的导入结果，请重试。`)
      }
      imported.set(file, id)
    }
    // 全文核验由服务端等待材料解析并推送进度，此处保留起草的材料准备流程。
    if (!documents.length) {
      const deadline = Date.now() + materialWaitLimit
      for (;;) {
        check()
        const { workspace } = await api.getWorkspace(signal)
        // PowerPoint 可作为材料导入，但现有正文解析队列不处理此格式。
        const materials = workspace.evidences.filter(item => item.caseId === caseId && item.storageKey && !/\.pptx?$/i.test(item.fileName))
        const blocked = materials.find(item => item.parsing?.status === 'failed' || item.parsing?.status === 'review_required')
        if (blocked) throw new Error(`材料「${blocked.fileName}」需要处理。请返回工作台检查解析结果后重试。`)
        const ready = materials.filter(item => item.parsing?.status === 'ready').length
        if (ready === materials.length) break
        if (Date.now() >= deadline) throw new Error('等待案件原材料解析超时，可稍后重试。')
        report(`正在解析案件原材料 · 已完成 ${ready}/${materials.length} 份`, name)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    return documents.map(file => ({ id: imported.get(file)!, title: file.name.replace(/\.[^.]+$/, '') }))
  }
}
