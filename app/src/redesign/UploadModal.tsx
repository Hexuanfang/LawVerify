import { useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './components/ui/dialog'
import { api } from '../api'
import { useApp } from './AppContext'
import { importDocument } from './services'
import { CaseFileCard } from './CaseFileCard'
import { CaseMaterialCard } from './CaseMaterialCard'
import { prepareEvidenceUpload, prepareMaterialLinks } from './caseSetup'

export function UploadModal() {
  const app = useApp()
  const [documents, setDocuments] = useState<File[]>([])
  const [evidence, setEvidence] = useState<File[]>([])
  const [links, setLinks] = useState<CaseMaterialSelection[]>([])
  const [progress, setProgress] = useState('')
  const [importing, setImporting] = useState(false)
  const [materialPickerOpen, setMaterialPickerOpen] = useState(false)
  const [reading, setReading] = useState(0)
  const onReading = (active: boolean) => setReading(current => current + (active ? 1 : -1))
  const submitting = useRef(false)
  const filesBusy = app.busy || importing || reading > 0
  const busy = filesBusy || materialPickerOpen
  const imported = useRef(new Map<File, string>())
  const importedEvidence = useRef(new Set<File>())
  const syncedLinks = useRef(new Set<string>())
  const project = app.projects.find(item => item.id === app.documentCase)
  const close = () => app.setDocumentCase(null)
  const canVerify = Boolean(project?.mats.length || evidence.length || links.length)

  const start = async () => {
    if (!project || submitting.current || busy || !documents.length || !canVerify) return
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
      const account = sessionStorage.getItem('lawverify-login-account') || ''
      const linkMaterials = prepareMaterialLinks(account, caseId, syncedLinks.current)
      const active = () => session === sessionStorage.getItem('lawverify-auth-session') && account === sessionStorage.getItem('lawverify-login-account')
      app.setCaseIdForUpload(caseId, '')
      close()
      await app.verify([], async (signal, report) => {
        const check = () => {
          signal.throwIfAborted()
          if (!active()) throw new Error('当前登录账号已变化，请重新打开页面。')
        }
        const reportMaterial = (message: string) => {
          if (!signal.aborted) report(message, project.name)
        }
        await uploadEvidence(evidence, check, reportMaterial)
        await linkMaterials(links, check, () => !signal.aborted && active(), reportMaterial)
        check()
        if (app.workspace?.cases.find(item => item.id === caseId)?.status === 'ready')
          await api.updateCase(caseId, { status: 'in_review' })
        for (const [index, file] of parseOrder.entries()) {
          check()
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
    } finally {
      submitting.current = false
      setImporting(false)
    }
  }
  if (!project) return null
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }}>
    <DialogContent className="fm-box new-upload" aria-busy={busy} aria-describedby={undefined}
      onInteractOutside={event => { if (busy) event.preventDefault() }}
      onEscapeKeyDown={event => { if (busy) event.preventDefault() }} showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>导入材料或文书 · {project.name}</DialogTitle>
      </DialogHeader>
      <div className="case-files-grid case-files-verify">
        <CaseMaterialCard links={links} onLinks={setLinks} files={evidence} onFiles={setEvidence} disabled={filesBusy}
          pickerOpen={materialPickerOpen} onPicking={setMaterialPickerOpen} onReading={onReading} />
        <CaseFileCard files={documents} onFiles={setDocuments} disabled={filesBusy} pickerOpen={materialPickerOpen} onReading={onReading} />
      </div>
      {importing && <div className="upload-import-feedback" role="status" aria-live="polite" aria-atomic="true">
        <div className="upload-import-heading">
          <LoaderCircle className="import-spinner" size={20} aria-hidden="true" />
          <div><b>{progress}</b>{documents.length > 0 && <p>处理完成后自动打开文书，请稍候。</p>}</div>
        </div>
        <div className="upload-import-track" aria-hidden="true"><i /></div>
      </div>}
      <div className="upload-actions">
        {!importing && <span role="status">{progress || (documents.length > 0 && !canVerify ? '添加证据后可开始核验。' : '')}</span>}
        <Button className="btn btn-pri" disabled={!documents.length || !canVerify || busy} onClick={() => void start()}>导入并核验</Button>
      </div>
    </DialogContent>
  </Dialog>
}
