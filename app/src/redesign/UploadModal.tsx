import { useRef, useState } from 'react'
import { FileUp, LoaderCircle, X } from 'lucide-react'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import { api } from '../api'
import { useApp } from './AppContext'
import { importDocument } from './services'
import { supportsDocumentFile } from './documentFile'
import type { DocKey } from '../types'
import { DocumentTypeSelect } from './DocumentTypeSelect'
import { DirectoryLinksModal } from './DirectoryLinksModal'

type CaseFileSetup = { caseId: string; task: 'verify' | 'draft'; onImported: () => void; onContinue: () => void }

export function UploadModal({ setup }: { setup?: CaseFileSetup }) {
  const app = useApp()
  const [documents, setDocuments] = useState<File[]>([])
  const [docKeys, setDocKeys] = useState(new Map<File, DocKey | undefined>())
  const [progress, setProgress] = useState('')
  const [importing, setImporting] = useState(false)
  const submitting = useRef(false)
  const busy = app.busy || importing
  const imported = useRef(new Map<File, string>())
  const project = app.projects.find(item => item.id === (setup?.caseId ?? app.documentCase))
  const draftOnly = setup?.task === 'draft'
  const close = () => setup ? setup.onContinue() : app.setDocumentCase(null)
  const finishImport = () => setup ? setup.onImported() : app.setDocumentCase(null)
  const select = (files: File[]) => {
    if (files.some(file => !supportsDocumentFile(file.name))) {
      app.toast('文书仅支持 Word（.doc、.docx）或 TXT。')
      return
    }
    setDocuments(current => [
      ...current,
      ...files.filter(file => !current.some(previous =>
        previous.name === file.name &&
        previous.size === file.size &&
        previous.lastModified === file.lastModified,
      )),
    ])
  }
  const start = async (verifyAfter: boolean) => {
    if (!project || submitting.current || app.busy) return
    submitting.current = true
    setImporting(true)
    setProgress('正在准备导入，保存当前文书草稿…')
    try {
      if (!(await app.flushDocument())) {
        setProgress('请先处理当前文书的草稿保存提示。')
        return
      }
      const caseId = project.id
      if (verifyAfter) {
        app.setCaseIdForUpload(caseId, '')
        finishImport()
        await app.verify([], async (signal, report) => {
          if (app.workspace?.cases.find(item => item.id === caseId)?.status === 'ready')
            await api.updateCase(caseId, { status: 'in_review' })
          const result: Array<{ id: string; title: string }> = []
          for (const [index, file] of documents.entries()) {
            signal.throwIfAborted()
            report(
              '导入第 ' + (index + 1) + '/' + documents.length + ' 份 · ' + (imported.current.has(file) ? '已导入文书' : '正在解析文书') + ' ' + file.name,
              file.name,
            )
            if (!imported.current.has(file)) {
              const saved = await importDocument(caseId, file, signal, undefined, docKeys.get(file))
              imported.current.set(file, saved.certificate.id)
            }
            result.push({ id: imported.current.get(file)!, title: file.name.replace(/\.[^.]+$/, '') })
          }
          return result
        })
        return
      }
      let nextDoc = project.docs[0] ?? ''
      const saved = await app.run(async () => {
        if (app.workspace?.cases.find(item => item.id === caseId)?.status === 'ready')
          await api.updateCase(caseId, { status: 'in_review' })
        for (const [index, file] of documents.entries()) {
          if (!imported.current.has(file)) {
            const result = await importDocument(caseId, file, undefined, message => {
              setProgress('第 ' + (index + 1) + '/' + documents.length + ' 份 · ' + message + ' ' + file.name)
            }, docKeys.get(file))
            imported.current.set(file, result.certificate.id)
          }
          nextDoc = imported.current.get(file)!
        }
        setProgress('正在刷新案件工作区，完成后打开文书…')
      })
      if (saved) {
        app.setCaseIdForUpload(caseId, nextDoc)
        finishImport()
        app.toast('文书已导入，可直接编辑或稍后核验')
      } else setProgress('导入未完成，请查看错误提示后重试。')
    } finally {
      submitting.current = false
      setImporting(false)
    }
  }
  if (!project) return null
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }}>
    <DialogContent className={`fm-box new-upload${setup ? ' case-files-setup' : ''}${draftOnly ? ' case-files-draft' : ''}`} aria-busy={busy}
      onInteractOutside={event => { if (busy) event.preventDefault() }}
      onEscapeKeyDown={event => { if (busy) event.preventDefault() }} showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>{setup ? '添加案件文件' : '导入待核验文书'} · {project.name}</DialogTitle>
        <DialogDescription>{setup
          ? draftOnly ? '链接合同、流水、沟通记录等原材料，供 AI 起草参考。' : '链接证据目录并选择待核验文书，也可以先导入文书，稍后补充材料。'
          : '导入起诉状、答辩状等已撰写文书，在工作台中直接编辑和核验。'}</DialogDescription>
      </DialogHeader>
      <div className="case-files-grid">
        {setup && <section className="case-files-material" aria-labelledby="case-files-material-heading">
          <div className="case-files-card-head"><h3 id="case-files-material-heading">案件原材料</h3><span>{project.mats.length} 份</span></div>
          <p>首次链接会导入目录内的材料。文件有变动时，点击「立即同步」。</p>
          <DirectoryLinksModal embeddedCaseId={setup.caseId} disabled={importing} />
        </section>}
        {!draftOnly && <section className="case-files-document" aria-labelledby="case-files-document-heading">
          <div className="case-files-card-head"><h3 id="case-files-document-heading">待核验文书</h3><span>Word / TXT</span></div>
          <label className={`dz ${busy ? 'disabled' : ''}`} onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); if (!busy) select(Array.from(event.dataTransfer.files)) }}>
        <input type="file" multiple disabled={busy} className="sr-only" aria-label="上传已撰写文书" accept=".doc,.docx,.txt"
          onChange={event => { select(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        <FileUp size={23} aria-hidden="true" />
        <b>拖拽或点击选择文书</b>
      </label>
      <div className="chips">
        {documents.map((file, index) => (
          <div className="chip" key={`${file.name}-${index}`}>
            <div className="fico l2">文</div>
            <div className="document-import-name">
              <div className="n">{file.name}</div>
              <div className="s">{(file.size / 1024).toFixed(1)} KB</div>
              <DocumentTypeSelect value={docKeys.get(file)} label={`${file.name}的文书类型`} disabled={busy || imported.current.has(file)}
                onChange={value => setDocKeys(current => new Map(current).set(file, value))} />
            </div>
            <Button variant="ghost" size="icon" disabled={busy} aria-label={`移除 ${file.name}`}
              onClick={() => setDocuments(current => current.filter(item => item !== file))}>
              <X size={12} />
            </Button>
          </div>
        ))}
      </div>
        </section>}
      </div>
      {importing && <div className="upload-import-feedback" role="status" aria-live="polite" aria-atomic="true">
        <div className="upload-import-heading">
          <LoaderCircle className="import-spinner" size={20} aria-hidden="true" />
          <div><b>{progress}</b><p>处理完成后自动打开文书，请稍候。</p></div>
        </div>
        <div className="upload-import-track" aria-hidden="true"><i /></div>
      </div>}
      <div className="upload-actions">
        {draftOnly ? <Button className="btn btn-pri" onClick={close} disabled={busy}>进入起草</Button> : <>
          {!importing && <span role="status">{progress || (!project.mats.length ? '链接证据目录后可开始核验。' : '')}</span>}
          {setup && <Button variant="ghost" disabled={busy} onClick={close}>进入工作台</Button>}
          <Button className="btn btn-gh" disabled={!documents.length || busy} onClick={() => void start(false)}>{importing ? <><LoaderCircle className="import-spinner" size={14} aria-hidden="true" />正在导入…</> : '仅导入文书'}</Button>
          <Button className="btn btn-pri" disabled={!documents.length || !project.mats.length || busy} onClick={() => void start(true)}>导入并核验</Button>
        </>}
      </div>
    </DialogContent>
  </Dialog>
}
