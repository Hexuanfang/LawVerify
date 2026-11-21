import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Save } from 'lucide-react'
import { Button } from './components/ui/button'
import { useApp } from './AppContext'
import { documentExtensions } from './documentExtensions'
import { DocumentToolbar } from './DocumentToolbar'
import { useDocumentDraft } from './useDocumentDraft'
import { useInlineDeclarationEdit } from './useInlineDeclarationEdit'
import { refreshReviewHighlights, reviewHighlights } from './reviewHighlights'
import { wordExportReadiness } from './workflow'
import './document-editor.css'

export function DocumentEditor({ editing }: { editing: '' | 'declarations' | 'document' }) {
  const app = useApp()
  const certificate = app.certificate!
  const draft = useDocumentDraft(certificate, app.saveDocument)
  const inline = useInlineDeclarationEdit(app.edit, editing === 'declarations')
  const visibleElements = useRef(app.elements)
  const { registerDocumentGuard, toast } = app
  const [length, setLength] = useState(certificate.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0))
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [...documentExtensions(), reviewHighlights],
    content: draft.initialHtml,
    editable: false,
    parseOptions: { preserveWhitespace: 'full' },
    editorProps: {
      attributes: { class: 'whole-document-content', 'aria-label': '文书正文', spellcheck: 'false', tabindex: '0' },
      handleDOMEvents: {
        click: (_view, event) => {
          const mark = (event.target as HTMLElement).closest<HTMLElement>('[data-el]')
          const element = visibleElements.current.find(item => mark?.dataset.inlineDeclaration === item.id)
          if (element && !app.busy && !draft.recovery) {
            event.preventDefault()
            void inline.activate(element)
          }
          app.select(mark?.dataset.el || '')
          return false
        },
        keydown: (_view, event) => {
          if (event.key !== 'Enter' && event.key !== 'F2') return false
          const mark = (event.target as HTMLElement).closest<HTMLElement>('[data-inline-declaration]')
          const element = visibleElements.current.find(item => mark?.dataset.inlineDeclaration === item.id)
          if (!element || app.busy || draft.recovery) return false
          event.preventDefault()
          app.select(element.id)
          void inline.activate(element)
          return true
        },
      },
    },
    onUpdate: ({ editor: current }) => {
      draft.capture(current.getHTML())
      setLength(current.getText().replaceAll('\n', '').length)
      app.select('')
    },
  })
  const loadedHtml = useRef(draft.initialHtml)
  const ready = draft.ready && !draft.saving && !draft.recovery && !app.busy
  const editable = editing === 'document' && ready
  const exportable = ready && !draft.dirty && !draft.conflict && app.workspace
    && wordExportReadiness(app.workspace, certificate.id).allowed
  useEffect(() => { editor?.setEditable(Boolean(editable), false) }, [editor, editable])
  useEffect(() => {
    if (!editor || inline.active || loadedHtml.current === draft.initialHtml) return
    loadedHtml.current = draft.initialHtml
    editor.commands.setContent(draft.initialHtml, { emitUpdate: false, parseOptions: { preserveWhitespace: 'full' } })
    setLength(editor.getText().replaceAll('\n', '').length)
  }, [editor, draft.initialHtml, inline.active])
  useEffect(() => {
    if (!editor) return
    if (!inline.active) visibleElements.current = app.elements
    const editingDeclarations = editing === 'declarations' && draft.ready && !draft.recovery && !draft.dirty
    refreshReviewHighlights(editor, { elements: visibleElements.current, selected: app.selected, filter: app.filter,
      editing: editingDeclarations, active: inline.active })
  }, [editor, app.elements, app.selected, app.filter, draft.initialHtml, editing, draft.ready, draft.recovery, draft.dirty, inline.active])
  useEffect(() => { inline.active?.mark.focus({ preventScroll: true }) }, [inline.active])
  useEffect(() => {
    const next = inline.nextTarget
    if (!next || inline.active || !editor) return
    if (editing !== 'declarations') { inline.clearNextTarget(); return }
    const candidate = app.elements.find(item => item.paragraphId === next.anchor.paragraphId && item.start === next.start
      && item.quote === next.anchor.quote && item.declaration?.type === next.anchor.declaration?.type)
    if (!candidate) {
      inline.clearNextTarget()
      toast('声明位置已变化，请从正文重新选择。')
      return
    }
    const points = editor.view.dom.querySelectorAll<HTMLElement>('[data-inline-declaration]')
    if (!Array.from(points).some(mark => mark.dataset.inlineDeclaration === candidate.id)) return
    inline.clearNextTarget()
    app.select(candidate.id)
    void inline.activate(candidate)
  }, [app, draft.initialHtml, editing, editor, inline, toast])
  const save = useRef<() => Promise<boolean>>(async () => false)
  const flush = useRef<() => Promise<boolean>>(async () => true)
  useEffect(() => {
    save.current = async () => await inline.flush() && (editor ? draft.save(editor) : false)
    flush.current = async () => await inline.flush() && draft.flush()
  }, [editor, draft, inline])
  useEffect(() => registerDocumentGuard(async mode => {
    if (mode === 'draft') return flush.current()
    const saved = await save.current()
    if (!saved) toast('请先处理当前文书的草稿或保存提示')
    return saved
  }), [registerDocumentGuard, toast])
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
      {inline.status || draft.notice || (draft.ready ? '正文已同步' : '正在读取文书…')}</span>
      {inline.canDiscard && <Button variant="ghost" size="sm" disabled={app.busy}
        onClick={inline.discard}>放弃未保存修改</Button>}
      <span>{length.toLocaleString()} 字</span></footer>
  </section>
}
