import { useState } from 'react'
import { useApp } from './AppContext'
import { api } from '../api'
import { resumeCaseDirectorySync, stopCaseDirectorySync } from '../CaseDirectorySync'
import { removeCaseDrafts } from '../draft-store'
import { caseNoteKey } from './caseNotes'
import { evidenceCategoryKey } from './caseFileKind'
import { removeCaseReviewAudits } from './review-audit-store'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'

export interface CaseDeleteTarget {
  id: string
  name: string
  docs: readonly string[]
  trigger?: HTMLElement
  cleanupOnly?: boolean
}

const pendingKey = (owner: string) => `lawverify-pending-case-deletion:${owner}`

function pendingDeletions(owner: string): CaseDeleteTarget[] {
  try {
    const items: unknown = JSON.parse(localStorage.getItem(pendingKey(owner)) ?? '[]')
    return Array.isArray(items) ? items.filter(item => typeof item?.id === 'string'
      && typeof item.name === 'string' && Array.isArray(item.docs) && item.docs.every((id: unknown) => typeof id === 'string')) : []
  } catch {
    return []
  }
}

function savePendingDeletion(owner: string, id: string, target?: Omit<CaseDeleteTarget, 'trigger'>) {
  try {
    const items = pendingDeletions(owner).filter(item => item.id !== id)
    if (target) items.push(target)
    if (items.length) localStorage.setItem(pendingKey(owner), JSON.stringify(items))
    else localStorage.removeItem(pendingKey(owner))
  } catch {
    // 本机存储不可用时，仍可以在当前确认框重试。
  }
}

export function CaseDeleteDialog({ target, onClose }: { target: CaseDeleteTarget | null; onClose: () => void }) {
  const app = useApp()
  const userId = app.workspace?.user.id ?? ''
  const account = sessionStorage.getItem('lawverify-login-account') || ''
  const owner = JSON.stringify([account.trim().toLowerCase(), userId])
  const [recovery, setRecovery] = useState(() => app.page === 'home' && userId ? pendingDeletions(owner)[0] : undefined)
  const [submittedId, setSubmittedId] = useState<string>()
  const [deletedId, setDeletedId] = useState<string>()
  const selection = target ?? recovery
  const removed = Boolean(selection && (selection.cleanupOnly === true || deletedId === selection.id
    || !app.projects.some(project => project.id === selection.id)))
  const dismiss = () => {
    // 已提交但结果未知时，保留重试所需信息，等待重新读取工作区。
    if (selection && !removed && submittedId !== selection.id) savePendingDeletion(owner, selection.id)
    setSubmittedId(undefined)
    setDeletedId(undefined)
    setRecovery(undefined)
    onClose()
  }
  const remove = async () => {
    if (!selection || !app.workspace || app.busy) return
    const { id, name } = selection
    const docs = [...new Set([...selection.docs, ...app.workspace.certificates.filter(item => item.caseId === id).map(item => item.id)])]
    const session = sessionStorage.getItem('lawverify-auth-session')
    if (await app.run(async () => {
      setSubmittedId(id)
      savePendingDeletion(owner, id, { id, name, docs, cleanupOnly: removed })
      await stopCaseDirectorySync(account, id)
      let cleanupError: unknown
      try {
        if (account !== (sessionStorage.getItem('lawverify-login-account') || '')
          || session !== sessionStorage.getItem('lawverify-auth-session')) {
          throw new Error('登录会话已变化，请重新打开案件后重试。')
        }
        await api.deleteCase(id)
      } catch (cause) {
        if ((cause as { code?: string } | null)?.code !== 'CASE_FILE_CLEANUP_FAILED') {
          resumeCaseDirectorySync(account, id)
          throw cause
        }
        cleanupError = cause
      }
      setDeletedId(id)
      savePendingDeletion(owner, id, { id, name, docs, cleanupOnly: true })
      try {
        await window.lawVerifyDesktop?.clearCaseDirectories?.({ account, caseId: id })
        await Promise.all([removeCaseDrafts(account, docs), removeCaseReviewAudits(account, docs, id)])
        localStorage.removeItem(caseNoteKey(userId, id))
        localStorage.removeItem(evidenceCategoryKey(account, id))
        const recent = `lawverify-new-last:${userId}`
        let savedCaseId: string | undefined
        try { savedCaseId = JSON.parse(localStorage.getItem(recent) ?? 'null')?.caseId }
        catch { /* 无法读取旧的访问记录，继续完成案件删除。 */ }
        if (savedCaseId === id) localStorage.removeItem(recent)
      } catch {
        throw new Error('案件已删除，本机记录清理未完成。请重试。')
      }
      if (cleanupError) throw cleanupError
      savePendingDeletion(owner, id)
    }, '已删除案件')) dismiss()
  }

  return (
    <Dialog open={Boolean(selection)} onOpenChange={open => { if (!open && !app.busy) dismiss() }}>
      <DialogContent className="fm-box new-form" showCloseButton={!app.busy}
        onCloseAutoFocus={event => {
          if (selection?.trigger?.isConnected) {
            event.preventDefault()
            selection.trigger.focus()
          }
        }}>
        <DialogHeader>
          <DialogTitle>{removed ? '案件文件待清理' : '删除案件？'}</DialogTitle>
          <DialogDescription>
            {removed ? `可重试清理「${selection?.name}」在应用内的剩余文件和记录。`
              : `将永久删除「${selection?.name}」及应用内保存的文书、材料副本和记录。链接目录里的原件、已导出的文件及整库备份仍会保留。`}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-ft">
          <Button className="btn btn-gh" disabled={app.busy} onClick={dismiss}>{removed ? '关闭' : '取消'}</Button>
          <Button variant="destructive" disabled={app.busy} onClick={() => void remove()}>
            {app.busy ? '正在删除…' : removed ? '重试清理' : '确认删除'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
