import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import { api } from '../api'
import { useApp } from './AppContext'
import { importDocument } from './services'

export function UploadModal() {
  const app = useApp()
  const [documents, setDocuments] = useState<File[]>([])
  const [progress, setProgress] = useState('')
  const imported = useRef(new Map<File, string>())
  const project = app.projects.find(item => item.id === app.documentCase)
  const select = (files: File[]) => {
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
    if (!project || !(await app.flushDocument())) return
    const caseId = project.id
    let nextDoc = project.docs[0] ?? ''
    const saved = await app.run(async () => {
      if (app.workspace?.cases.find(item => item.id === caseId)?.status === 'ready')
        await api.updateCase(caseId, { status: 'in_review' })
      for (const file of documents) {
        if (!imported.current.has(file)) {
          setProgress(`正在解析文书 ${file.name}`)
          const result = await importDocument(caseId, file)
          imported.current.set(file, result.certificate.id)
        }
        nextDoc = imported.current.get(file)!
      }
    })
    if (saved) {
      app.setCaseIdForUpload(caseId, nextDoc)
      app.setDocumentCase(null)
      if (verifyAfter) await app.verify(nextDoc)
      else app.toast('文书已导入，可直接编辑或稍后核验')
    }
  }
  if (!project) return null
  return <Dialog open onOpenChange={open => { if (!open && !app.busy) app.setDocumentCase(null) }}>
    <DialogContent className="fm-box new-upload"
      onInteractOutside={event => { if (app.busy) event.preventDefault() }}
      onEscapeKeyDown={event => { if (app.busy) event.preventDefault() }} showCloseButton={!app.busy}>
      <DialogHeader>
        <DialogTitle>导入待核验文书 · {project.name}</DialogTitle>
        <DialogDescription>导入起诉状、答辩状等已撰写文书，在工作台中直接编辑和核验。案件材料通过本地文件夹联动接入。</DialogDescription>
      </DialogHeader>
      <label className={`dz ${app.busy ? 'disabled' : ''}`} onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); if (!app.busy) select(Array.from(event.dataTransfer.files)) }}>
        <input type="file" multiple disabled={app.busy} className="sr-only" aria-label="上传已撰写文书" accept=".docx,.pdf,.txt,.md"
          onChange={event => { select(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        <b>拖拽或点击选择文书</b>
        <span>Word · PDF · TXT · Markdown</span>
      </label>
      <div className="chips">
        {documents.map((file, index) => (
          <div className="chip" key={`${file.name}-${index}`}>
            <div className="fico l2">文</div>
            <div className="document-import-name">
              <div className="n">{file.name}</div>
              <div className="s">{(file.size / 1024).toFixed(1)} KB</div>
            </div>
            <Button variant="ghost" size="icon" disabled={app.busy} aria-label={`移除 ${file.name}`}
              onClick={() => setDocuments(current => current.filter(item => item !== file))}>
              <X size={12} />
            </Button>
          </div>
        ))}
      </div>
      <div className="upload-actions">
        <Button className="btn btn-gh" disabled={!documents.length || app.busy} onClick={() => void start(false)}>仅导入文书</Button>
        <Button className="btn btn-pri" disabled={!documents.length || !project.mats.length || app.busy} onClick={() => void start(true)}>导入并核验</Button>
        <span role="status">{progress || (project.mats.length ? '导入后可直接开始核验' : '可先导入文书，再链接案件材料目录')}</span>
      </div>
    </DialogContent>
  </Dialog>
}
