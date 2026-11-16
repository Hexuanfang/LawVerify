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
  const paused = app.workspace?.cases.find(item => item.id === caseId)?.agent?.autoAnalyze === false
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
          if (authorized()) setProgress(`${item.name} · 已同步 ${completed}/${total} 个文件`)
        })
      }
      if (authorized()) setDirectories(await desktop!.scanCaseDirectories!({ account, caseId }))
    })
    if (authorized()) setProgress('')
  }
  const toggle = () => app.run(async () => {
    await api.retryCaseAgent(caseId, paused)
    if (paused) resumeCaseDirectorySync(account, caseId)
  }, paused ? '已恢复目录同步与自动梳理' : '已暂停目录同步与自动梳理')
  const clear = async () => {
    const saved = await app.run(async () => {
      await stopCaseDirectorySync(account, caseId)
      if (!authorized()) return
      await desktop!.clearCaseDirectories!({ account, caseId })
      await api.clearCaseDirectoryEvidences(caseId)
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
  return <Dialog open onOpenChange={open => { if (!open && !app.busy) close() }}>
    <DialogContent className="fm-box new-directory" showCloseButton={false}
      onInteractOutside={event => { if (app.busy) event.preventDefault() }}
      onEscapeKeyDown={event => { if (app.busy) event.preventDefault() }}>
      <DialogHeader>
        <DialogTitle>本地文件夹联动 · {project.name}</DialogTitle>
        <DialogDescription>链接本机材料目录，自动同步新增、修改和删除。窗口可见时每 60 秒检查一次，返回窗口时也会检查。</DialogDescription>
      </DialogHeader>
      {supported ? <>
        <div className="directory-status" role="status">{loading ? '正在读取已链接目录…' : progress || (paused ? '目录同步与自动梳理已暂停' : '目录同步已开启')}</div>
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
          <Button className="btn btn-pri" disabled={app.busy || loading} onClick={() => void sync(true)}>
            <Link2 size={15} />链接目录
          </Button>
          <Button className="btn btn-gh" disabled={app.busy || loading || !directories.length || paused} onClick={() => void sync(false)}>
            <RefreshCw size={15} />立即同步
          </Button>
          <Button className="btn btn-gh" disabled={app.busy || loading || !directories.length} onClick={() => void toggle()}>
            {paused ? '恢复同步' : '暂停同步'}
          </Button>
          <Button className="btn btn-gh" disabled={app.busy || loading} onClick={() => setConfirmClear(true)}>
            解除链接
          </Button>
        </div>
        {confirmClear && <div className="directory-confirm" role="alert">
          <p>解除此案件的全部文件夹链接，并清除系统内对应的目录证据记录。本地原文件、单独导入的文书和其他材料会保留。</p>
          <Button className="btn btn-gh" disabled={app.busy} onClick={() => setConfirmClear(false)}>取消解除</Button>
          <Button className="btn btn-pri" disabled={app.busy} onClick={() => void clear()}>确认解除并清除记录</Button>
        </div>}
      </> : <p role="status">本地文件夹持续同步需要使用 LawVerify 桌面客户端。</p>}
      <div className="fm-ft">
        <Button className="btn btn-gh" disabled={app.busy} onClick={() => { close(); app.setDocumentCase(caseId) }}>导入待核验文书</Button>
        <Button className="btn btn-pri" disabled={app.busy} onClick={close}>完成</Button>
      </div>
    </DialogContent>
  </Dialog>
}
