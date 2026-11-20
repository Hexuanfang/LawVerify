import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Save } from 'lucide-react'
import { Button } from './components/ui/button'
import { useApp } from './AppContext'
import { documentExtensions } from './documentExtensions'
import { DocumentToolbar } from './DocumentToolbar'
import { useDocumentDraft } from './useDocumentDraft'
import { refreshReviewHighlights, reviewHighlights } from './reviewHighlights'
import { wordExportReadiness } from './workflow'
import './document-editor.css'

export function DocumentEditor({ editing }: { editing: boolean }) {
  const app = useApp()
  const certificate = app.certificate!
  const draft = useDocumentDraft(certificate, app.saveDocument)
  const [length, setLength] = useState(certificate.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0))
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [...documentExtensions(), reviewHighlights],
    content: draft.initialHtml,
    editable: false,
    parseOptions: { preserveWhitespace: 'full' },
    editorProps: {
      attributes: { class: 'whole-document-content', 'aria-label': '文书正文', spellcheck: 'false', tabindex: '0' },
      handleDOMEvents: { click: (_view, event) => {
        const mark = (event.target as HTMLElement).closest<HTMLElement>('[data-el]')
        app.select(mark?.dataset.el || '')
        return false
      } },
    },
    onUpdate: ({ editor: current }) => {
      draft.capture(current.getHTML())
      setLength(current.getText().replaceAll('\n', '').length)
      app.select('')
    },
  })
  const loadedHtml = useRef(draft.initialHtml)
  const ready = draft.ready && !draft.saving && !draft.recovery && !app.busy
  const editable = editing && ready
  const exportable = ready && !draft.dirty && !draft.conflict && app.workspace
    && wordExportReadiness(app.workspace, certificate.id).allowed
  useEffect(() => { editor?.setEditable(Boolean(editable), false) }, [editor, editable])
  useEffect(() => {
    if (!editor || loadedHtml.current === draft.initialHtml) return
    loadedHtml.current = draft.initialHtml
    editor.commands.setContent(draft.initialHtml, { emitUpdate: false, parseOptions: { preserveWhitespace: 'full' } })
    setLength(editor.getText().replaceAll('\n', '').length)
  }, [editor, draft.initialHtml])
  useEffect(() => {
    if (!editor) return
    refreshReviewHighlights(editor, { elements: app.elements, selected: app.selected, filter: app.filter })
  }, [editor, app.elements, app.selected, app.filter, draft.initialHtml])
  const save = useRef<() => Promise<boolean>>(async () => false)
  const flush = useRef<() => Promise<boolean>>(async () => true)
  useEffect(() => {
    save.current = async () => editor ? draft.save(editor) : false
    flush.current = draft.flush
  }, [editor, draft])
  useEffect(() => app.registerDocumentGuard(async mode => {
    if (mode === 'draft') return flush.current()
    const saved = await save.current()
    if (!saved) app.toast('请先处理当前文书的草稿或保存提示')
    return saved
  }), [app])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  return <section className="document-editor-inline" aria-label="文书编辑区">
    <div className="document-editor-tools">
      {editor && <DocumentToolbar editor={editor} disabled={!editable} />}
      <Button className="document-save-button" disabled={!draft.dirty || !editable || draft.conflict}
        onClick={() => void save.current()}><Save size={14} />{draft.saving ? '正在保存…' : '保存文书'}</Button>
      <Button variant="outline" disabled={!exportable} onClick={() => void app.exportWord('original')}>导出原格式</Button>
    </div>
    <div className="document-editor-notices">
      {draft.recovery && <div className="document-editor-notice">发现未提交的文书草稿。
        <Button variant="outline" disabled={!editor} onClick={() => { if (editor) { draft.restore(editor); setLength(editor.getText().replaceAll('\n', '').length) } }}>恢复草稿</Button>
        <Button variant="ghost" onClick={() => void draft.discardRecovery()}>使用已保存正文</Button></div>}
      {draft.conflict && <div className="document-editor-notice">正文已有更新，请对照后再保存。
        <details><summary>查看最新保存的正文</summary><pre>{certificate.paragraphs.map(paragraph => paragraph.text).join('\n\n')}</pre></details>
        <Button variant="outline" disabled={!editor || Boolean(draft.recovery)} onClick={() => editor && draft.adoptLatestBase(editor)}>已核对，以最新版本为基线继续</Button></div>}
    </div>
    <div className="doc-scroll document-editor-canvas"><article className={`doc-paper document-editor-paper ${app.filter !== 'all' ? 'filtering' : ''} ${app.selected ? 'sel-mode' : ''}`}><EditorContent editor={editor} /></article></div>
    <footer className="document-editor-status"><span role="status" className={draft.draftError ? 'draft-error' : ''}>
      {draft.notice || (draft.ready ? '正文已同步' : '正在读取文书…')}</span><span>{length.toLocaleString()} 字</span></footer>
  </section>
}
