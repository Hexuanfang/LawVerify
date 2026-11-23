import { useEffect, useRef, useState } from 'react'
import { FolderOpen, LoaderCircle } from 'lucide-react'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import { api } from '../api'
import { useApp } from './AppContext'
import { importDocument } from './services'
import { CaseFileCard } from './CaseFileCard'
import { detectCaseFileKind, type CaseFileKind } from './caseFileKind'
import { prepareEvidenceUpload } from './caseSetup'

export function UploadModal() {
  const app = useApp()
  const [files, setFiles] = useState<File[]>([])
  const [kinds, setKinds] = useState(new Map<File, CaseFileKind>())
  const [progress, setProgress] = useState('')
  const [importing, setImporting] = useState(false)
  const [reading, setReading] = useState(false)
  const submitting = useRef(false)
  const busy = app.busy || importing || reading
  const imported = useRef(new Map<File, string>())
  const importedEvidence = useRef(new Set<File>())
  const project = app.projects.find(item => item.id === app.documentCase)
  const close = () => app.setDocumentCase(null)
  const documents = files.filter(file => kinds.get(file) === 'document')
  const evidence = files.filter(file => kinds.get(file) === 'evidence')
  const detecting = documents.length + evidence.length < files.length
  const canVerify = Boolean(project?.mats.length || evidence.length)
  useEffect(() => {
    const pending = files.filter(file => !kinds.has(file))
    if (!pending.length) return
    let active = true
    void Promise.all(pending.map(async file => [file, await detectCaseFileKind(file)] as const)).then(results => {
      if (!active) return
      setKinds(current => new Map([...current, ...results]))
    })
    return () => { active = false }
  }, [files, kinds])

  const start = async (verifyAfter: boolean) => {
    if (!project || submitting.current || busy || detecting || !files.length) return
    submitting.current = true
    setImporting(true)
    setProgress('正在准备导入，保存当前文书草稿…')
    try {
      if (!(await app.flushDocument())) {
        setProgress('请先处理当前文书的草稿保存提示。')
        return
      }
      const caseId = project.id
      const parseOrder = [...documents].sort((left, right) => left.size - right.size)
      const uploadEvidence = prepareEvidenceUpload(caseId, importedEvidence.current)
      const session = sessionStorage.getItem('lawverify-auth-session')
      const account = sessionStorage.getItem('lawverify-login-account')
      const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted()
        if (session !== sessionStorage.getItem('lawverify-auth-session') || account !== sessionStorage.getItem('lawverify-login-account'))
          throw new Error('当前登录账号已变化，请重新打开页面。')
      }
      if (verifyAfter) {
        app.setCaseIdForUpload(caseId, '')
        close()
        await app.verify([], async (signal, report) => {
          await uploadEvidence(evidence, () => check(signal), message => {
            if (!signal.aborted) report(message, project.name)
          })
          check(signal)
          if (app.workspace?.cases.find(item => item.id === caseId)?.status === 'ready')
            await api.updateCase(caseId, { status: 'in_review' })
          for (const [index, file] of parseOrder.entries()) {
            check(signal)
            report(
              '导入第 ' + (index + 1) + '/' + documents.length + ' 份 · ' + (imported.current.has(file) ? '已导入文书' : '正在解析文书') + ' ' + file.name,
              file.name,
            )
            if (!imported.current.has(file)) {
              const saved = await importDocument(caseId, file, signal)
              imported.current.set(file, saved.certificate.id)
            }
          }
          return documents.map(file => ({ id: imported.current.get(file)!, title: file.name.replace(/\.[^.]+$/, '') }))
        })
        return
      }
      const saved = await app.run(async () => {
        await uploadEvidence(evidence, check, setProgress)
        check()
        if (documents.length && app.workspace?.cases.find(item => item.id === caseId)?.status === 'ready')
          await api.updateCase(caseId, { status: 'in_review' })
        for (const [index, file] of parseOrder.entries()) {
          check()
          if (!imported.current.has(file)) {
            const result = await importDocument(caseId, file, undefined, message => {
              setProgress('第 ' + (index + 1) + '/' + documents.length + ' 份 · ' + message + ' ' + file.name)
            })
            imported.current.set(file, result.certificate.id)
          }
        }
        setProgress('正在刷新案件工作区…')
      })
      if (saved) {
        const lastFile = documents.at(-1)
        if (lastFile) app.setCaseIdForUpload(caseId, imported.current.get(lastFile)!)
        close()
        app.toast(evidence.length ? (documents.length ? '材料和文书已导入' : '材料已导入，正在后台解析') : '文书已导入，可直接编辑或稍后核验')
      } else setProgress('导入未完成，请查看错误提示后重试。')
    } finally {
      submitting.current = false
      setImporting(false)
    }
  }
  if (!project || app.uploadCase) return null
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }}>
    <DialogContent className="fm-box new-upload" aria-busy={busy}
      onInteractOutside={event => { if (busy) event.preventDefault() }}
      onEscapeKeyDown={event => { if (busy) event.preventDefault() }} showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>导入材料或文书 · {project.name}</DialogTitle>
        <DialogDescription>可一起上传证据和待核验文书，系统会自动识别各文件的导入类型。</DialogDescription>
      </DialogHeader>
      <div className="case-files-grid">
        <CaseFileCard files={files} onFiles={setFiles} disabled={busy} onReading={setReading} fileKind={file => {
          const kind = kinds.get(file)
          const saved = imported.current.has(file) || importedEvidence.current.has(file)
          if (!kind) return <small role="status">正在识别…</small>
          return <small className="upload-file-kind">{kind === 'document' ? '待核验文书' : '证据'}{saved ? ' · 已导入' : ''}</small>
        }} />
      </div>
      <Button className="btn btn-gh upload-directory" disabled={busy} onClick={() => app.setUploadCase(project.id)}>
        <FolderOpen size={15} aria-hidden="true" />管理本地文件夹联动
      </Button>
      {importing && <div className="upload-import-feedback" role="status" aria-live="polite" aria-atomic="true">
        <div className="upload-import-heading">
          <LoaderCircle className="import-spinner" size={20} aria-hidden="true" />
          <div><b>{progress}</b>{documents.length > 0 && <p>处理完成后自动打开文书，请稍候。</p>}</div>
        </div>
        <div className="upload-import-track" aria-hidden="true"><i /></div>
      </div>}
      <div className="upload-actions">
        {!importing && <span role="status">{progress || (documents.length > 0 && !canVerify ? '添加证据后可开始核验。' : '')}</span>}
        <Button className={documents.length ? 'btn btn-gh' : 'btn btn-pri'} disabled={!files.length || busy || detecting} onClick={() => void start(false)}>
          {importing ? <><LoaderCircle className="import-spinner" size={14} aria-hidden="true" />正在导入…</> : documents.length ? (evidence.length ? '仅导入' : '仅导入文书') : '导入材料'}
        </Button>
        <Button className="btn btn-pri" disabled={!documents.length || !canVerify || busy || detecting} onClick={() => void start(true)}>导入并核验</Button>
      </div>
    </DialogContent>
  </Dialog>
}
