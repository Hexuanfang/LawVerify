import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Link2, RefreshCw } from 'lucide-react'
import { api } from '../api'
import { resumeCaseDirectorySync, stopCaseDirectorySync, syncDesktopDirectory } from '../CaseDirectorySync'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'

export function DirectoryLinksModal() {
  const app = useApp()
  const { setError } = app
  const caseId = app.uploadCase!
  const project = app.projects.find(item => item.id === caseId)
  const account = sessionStorage.getItem('lawverify-login-account') || ''
  const session = sessionStorage.getItem('lawverify-auth-session')
  const [directories, setDirectories] = useState<CaseDirectoryManifest[]>([])
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const live = useRef(true)
  const desktop = window.lawVerifyDesktop
  const supported = Boolean(
    desktop?.linkCaseDirectory && desktop.scanCaseDirectories &&
    desktop.readCaseDirectoryFile && desktop.clearCaseDirectories,
  )
  const authorized = () => live.current &&
    account === sessionStorage.getItem('lawverify-login-account') &&
    session === sessionStorage.getItem('lawverify-auth-session')
  useEffect(() => {
    live.current = true
    let active = true
    const request = supported ? desktop!.scanCaseDirectories!({ account, caseId }) : Promise.resolve([])
    void request.then(items => {
      if (active) setDirectories(items)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '目录暂时无法读取，请重新链接。')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; live.current = false }
  }, [account, caseId, supported, desktop, setError])

  const sync = async (link: boolean) => {
    setProgress(link ? '正在选择和扫描文件夹…' : '正在扫描目录变化…')
    await app.run(async () => {
      const items = link
        ? await desktop!.linkCaseDirectory!({ account, caseId }).then(item => item ? [item] : [])
        : await desktop!.scanCaseDirectories!({ account, caseId })
      for (const item of items) {
        if (!authorized()) return
        resumeCaseDirectorySync(account, caseId)
        setDirectories(current => [...current.filter(directory => directory.id !== item.id), item])
        await syncDesktopDirectory(account, caseId, item, authorized, (completed, total) => {
          if (authorized()) setProgress(`${item.name} · 已${link ? '导入' : '同步'} ${completed}/${total} 个文件`)
        })
      }
      if (authorized()) setDirectories(await desktop!.scanCaseDirectories!({ account, caseId }))
    })
    if (authorized()) setProgress('')
  }
  const clear = async () => {
    const saved = await app.run(async () => {
      await stopCaseDirectorySync(account, caseId)
      if (!authorized()) return
      const { workspace } = await api.getWorkspace()
      const linkedEvidence = workspace.evidences.filter(item => item.caseId === caseId && item.directoryId)
      for (const item of linkedEvidence) {
        if (!authorized()) return
        await api.deleteDirectoryEvidence(item.id)
      }
      if (!authorized()) return
      await desktop!.clearCaseDirectories!({ account, caseId })
    }, '已清除文件夹链接及对应目录证据')
    if (saved && authorized()) {
      setDirectories([])
      setConfirmClear(false)
    }
  }
  const close = () => {
    app.setUploadCase(null)
    if (app.page === 'home' && project) app.enter(project.id)
  }
  if (!project) return null
  const busy = app.busy
  const contents = supported ? <>
        <div className="directory-status" role="status">{loading ? '正在读取已链接目录…' : progress || (directories.length ? '目录已链接' : '尚未链接本地材料目录')}</div>
        <div className="directory-list">
          {directories.map(item => (
            <div className="directory-row" key={item.id}>
              <FolderOpen size={20} aria-hidden="true" />
              <div>
                <b>{item.name}</b>
                <span data-directory-files>{item.files.length} 个文件</span>
              </div>
            </div>
          ))}
          {!loading && !directories.length && <p>尚未链接本地材料目录</p>}
        </div>
        <div className="directory-actions">
          <Button className="btn btn-pri" disabled={busy || loading} onClick={() => void sync(true)}>
            <Link2 size={15} />链接目录
          </Button>
          <Button className="btn btn-gh" disabled={busy || loading || !directories.length} onClick={() => void sync(false)}>
            <RefreshCw size={15} />立即同步
          </Button>
          <Button className="btn btn-gh" disabled={busy || loading} onClick={() => setConfirmClear(true)}>
            解除链接
          </Button>
        </div>
        {confirmClear && <div className="directory-confirm" role="alert">
          <p>解除此案件的全部文件夹链接，并清除系统内对应的目录证据记录。本地原文件、单独导入的文书和其他材料会保留。</p>
          <Button className="btn btn-gh" disabled={busy} onClick={() => setConfirmClear(false)}>取消解除</Button>
          <Button className="btn btn-pri" disabled={busy} onClick={() => void clear()}>确认解除并清除记录</Button>
        </div>}
      </> : <p role="status">链接和同步本地文件夹需要使用 LawVerify 桌面客户端。</p>
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }}>
    <DialogContent className="fm-box new-directory" showCloseButton={false}
      onInteractOutside={event => { if (busy) event.preventDefault() }}
      onEscapeKeyDown={event => { if (busy) event.preventDefault() }}>
      <DialogHeader>
        <DialogTitle>本地文件夹联动 · {project.name}</DialogTitle>
        <DialogDescription>首次链接会导入目录内的材料。文件新增、修改或删除后，点击「立即同步」更新案件材料。</DialogDescription>
      </DialogHeader>
      {contents}
      <div className="fm-ft">
        <Button className="btn btn-pri" disabled={busy} onClick={close}>完成</Button>
      </div>
    </DialogContent>
  </Dialog>
}
