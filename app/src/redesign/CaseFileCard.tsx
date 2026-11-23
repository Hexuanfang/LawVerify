import { useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react'
import { FileUp, FolderOpen, X } from 'lucide-react'
import { Button } from './components/ui/button'
import { documentFileAccept, documentFileHint, supportsDocumentFile } from './documentFile'

const materialFileAccept = '.pdf,.doc,.docx,.rtf,.txt,.md,.markdown,.csv,.png,.jpg,.jpeg,.gif,.webp,.ppt,.pptx'
const materialFileTypes = new Set(materialFileAccept.split(','))
async function filesInEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    if (entry.fullPath.slice(1) !== file.name) {
      Object.defineProperty(file, 'webkitRelativePath', { value: entry.fullPath.slice(1) })
    }
    return [file]
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const files: File[] = []
  for (;;) {
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!entries.length) return files
    files.push(...(await Promise.all(entries.map(filesInEntry))).flat())
  }
}

export function CaseFileCard({ material = false, localLinks, children, files, onFiles, disabled, pickerOpen, onReading }: {
  material?: boolean
  localLinks?: { pick: () => void; drop: (files: File[]) => void }
  children?: ReactNode
  files: File[]
  onFiles: (update: (files: File[]) => File[]) => void
  disabled: boolean
  pickerOpen?: boolean
  onReading: (reading: boolean) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [feedback, setFeedback] = useState('')
  const [dragging, setDragging] = useState(false)
  const key = (file: File) => material ? (file.webkitRelativePath || file.name).toLowerCase()
    : JSON.stringify([file.webkitRelativePath || file.name, file.size, file.lastModified])
  const addFiles = (selected: File[]) => {
    const accepted = selected.filter(file => (material
      ? materialFileTypes.has(file.name.slice(file.name.lastIndexOf('.')).toLowerCase())
      : supportsDocumentFile(file.name)) && file.size <= (material ? 512 : 20) * 1024 ** 2)
    setFeedback(!selected.length ? '文件夹内没有可上传的文件。' : accepted.length === selected.length ? '' :
      `已跳过 ${selected.length - accepted.length} 个格式不支持或超出大小限制的文件。${material ? '单个原材料上限为 512 MB。' : documentFileHint + '单份文书上限为 20 MB。'}`)
    onFiles(current => {
      const unique = new Map(current.map(file => [key(file), file]))
      accepted.forEach(file => { if (!unique.has(key(file))) unique.set(key(file), file) })
      return [...unique.values()]
    })
  }
  const drop = async (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const files = Array.from(event.dataTransfer.files)
    if (localLinks) {
      localLinks.drop(files)
      return
    }
    const entries = Array.from(event.dataTransfer.items, item => item.webkitGetAsEntry?.()).filter(entry => entry != null)
    onReading(true)
    try { addFiles(entries.length ? (await Promise.all(entries.map(filesInEntry))).flat() : files) }
    catch { setFeedback('文件夹读取失败，请重新拖入。') }
    finally { onReading(false) }
  }
  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ''
  }
  const listLabel = material ? '案件原材料' : '待核验文书'
  const FileIcon = material ? FolderOpen : FileUp
  return <section className={material ? 'case-files-material' : 'case-files-document'} aria-label={listLabel}>
    <div className={`case-file-drop${dragging ? ' is-dragging' : ''}`} onDragOver={event => {
      event.preventDefault()
      if (!disabled) setDragging(true)
    }} onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
    }} onDrop={event => void drop(event)}>
      <button type="button" className="dz" disabled={disabled || pickerOpen} onClick={localLinks?.pick ?? (() => fileInput.current?.click())}>
        <FileIcon size={23} aria-hidden="true" />
        <b>{localLinks ? '链接原材料' : material ? '上传原材料' : '上传文书'}</b>
        <span className="text-[var(--ink-2)]">
          {!material && <>Word / TXT / Markdown<br /></>}
          {localLinks ? '点击浏览文件夹' : '点击浏览文件'}，也可拖入文件或文件夹
        </span>
      </button>
      {!localLinks && <input ref={fileInput} type="file" multiple hidden disabled={disabled} accept={material ? materialFileAccept : documentFileAccept}
        aria-label={material ? '选择案件原材料文件' : '上传已撰写文书'} onChange={selectFiles} />}
    </div>
    {feedback && <p className="case-file-feedback" role="status">{feedback}</p>}
    {children}
    {files.length > 0 && <ul className="case-file-list" aria-label={`已选择${listLabel}`}>
      {files.map(file => <li key={key(file)} className="chip">
        <FileUp size={17} aria-hidden="true" />
        <div><b>{file.webkitRelativePath || file.name}</b><small>{file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`}</small></div>
        <Button variant="ghost" size="icon" type="button" disabled={disabled || pickerOpen} aria-label={`移除 ${file.webkitRelativePath || file.name}`}
          onClick={() => onFiles(current => current.filter(item => item !== file))}><X size={14} aria-hidden="true" /></Button>
      </li>)}
    </ul>}
  </section>
}
