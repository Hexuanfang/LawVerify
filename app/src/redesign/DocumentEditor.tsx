import { useEffect, useMemo, useRef, useState } from 'react'
import type { SuperDoc } from 'superdoc'
import { Save } from 'lucide-react'
import 'superdoc/style.css'
import { Button } from './components/ui/button'
import { useApp } from './AppContext'
import { contentSnapshot, documentHtml, readSuperDocBlocks, type DocumentBlock } from './documentContent'
import { readDocxWork } from './documentFile'
import { reviewSelection, type DocumentSelection } from './documentSelection'
import { DocumentToolbar } from './DocumentToolbar'
import { createReviewHighlights, type ReviewTargetBlock } from './reviewHighlights'
import { useDocumentDraft } from './useDocumentDraft'
import { wordExportReadiness } from './workflow'
import './document-editor.css'

export type DocumentEditorProps = {
  onReviewSelect: (id: string) => void
  onSelectionChange: (selection?: DocumentSelection) => void
  onClearSelectionReady: (clear: (() => void) | null) => void
}

type EditorSession = {
  editor: SuperDoc
  ids: Map<string, string>
  targets: Map<string, ReviewTargetBlock[]>
  baseline: DocumentBlock[]
  inputFormat: string | undefined
  expectedFileVersion: string
  native: boolean
  highlights: ReturnType<typeof createReviewHighlights>
}

async function loadBody(editor: SuperDoc, blocks: DocumentBlock[]) {
  const doc = editor.activeEditor?.doc
  if (!doc) throw new Error('文书编辑器尚未就绪。')
  const body = document.createElement('template')
  body.innerHTML = documentHtml(blocks)
  // 旧版 HTML 编辑器按浏览器规则显示跨行单元格，SuperDoc 要求显式限定在现有行内。
  for (const cell of body.content.querySelectorAll<HTMLTableCellElement>('td[rowspan], th[rowspan]')) {
    const row = cell.parentElement
    const group = row?.parentElement
    if (!(row instanceof HTMLTableRowElement) || !(group instanceof HTMLTableSectionElement)) continue
    const remaining = group.rows.length - row.sectionRowIndex
    if (!cell.rowSpan || cell.rowSpan > remaining) cell.rowSpan = remaining
  }
  // 仅旧版 HTML 导入需要转换图片。打开原生 Word 时直接使用文件中的图片。
  await Promise.all(Array.from(body.content.querySelectorAll('img'), async image => {
    const source = image.getAttribute('src') ?? ''
    if (!/^data:image\/(?:gif|webp|bmp);base64,[a-z\d+/]+=*$/i.test(source)) return
    const decoded = new Image()
    decoded.src = source
    await decoded.decode()
    const canvas = document.createElement('canvas')
    canvas.width = decoded.naturalWidth
    canvas.height = decoded.naturalHeight
    canvas.getContext('2d')!.drawImage(decoded, 0, 0)
    image.src = canvas.toDataURL('image/png')
  }))
  const receipt = await doc.replace({ target: { kind: 'story', storyType: 'body' }, type: 'html', value: body.innerHTML })
  if (!receipt.success) throw new Error('无法载入文书正文，本机文书已保留。')
}

async function replaceEditorFile(editor: SuperDoc, bytes: Blob) {
  if (!(await editor.replaceDocument(bytes)).ok) throw new Error('无法恢复 Word 草稿，本机草稿已保留。')
}

async function restoreLegacyWord(session: EditorSession, blocks: DocumentBlock[]) {
  const { baseline, targets, editor } = session
  const doc = editor.activeEditor?.doc
  if (!doc || baseline.length !== blocks.length || baseline.some((block, index) => block.id !== blocks[index]?.id)) {
    throw new Error('旧草稿的段落结构与原 Word 不一致，本机草稿已保留。')
  }
  const changes = blocks.flatMap((block, index) => {
    const before = baseline[index]
    if (before.text === block.text && before.richText === block.richText) return []
    const pieces = targets.get(block.id)
    const piece = pieces?.[0]
    if (pieces?.length !== 1 || !piece || piece.text !== before.text) {
      throw new Error('旧草稿中的段落无法定位到原 Word，本机草稿已保留。')
    }
    return [{ before, block, piece }]
  })
  if (!changes.length) return
  const previous = await editor.export({ triggerDownload: false })
  try {
    for (const { before, block, piece } of changes) {
      let start = 0
      let end = before.text.length
      let nextEnd = block.text.length
      while (start < end && start < nextEnd && before.text[start] === block.text[start]) start++
      while (end > start && nextEnd > start && before.text[end - 1] === block.text[nextEnd - 1]) { end--; nextEnd-- }
      const offset = piece.offset ?? 0
      const target = { kind: 'selection', start: { kind: 'text', blockId: piece.blockId, offset: offset + start },
        end: { kind: 'text', blockId: piece.blockId, offset: offset + end } } as const
      const result = before.text === block.text
        ? await doc.replace({ type: 'html', value: documentHtml([block]),
          target: { kind: 'block', nodeType: 'paragraph', nodeId: piece.blockId } }, { replaceMode: 'contents' })
        : await doc.replace({ target, text: block.text.slice(start, nextEnd), expectedText: before.text.slice(start, end) })
      if (!result.success) throw new Error('原 Word 中的旧草稿更改无法安全恢复，本机草稿已保留。')
    }
  } catch (cause) {
    await replaceEditorFile(editor, previous)
    throw cause
  }
}

export function DocumentEditor(props: DocumentEditorProps) {
  const app = useApp()
  const certificate = app.certificate!
  const draft = useDocumentDraft(certificate, app.saveDocument)
  const { registerDocumentGuard, toast } = app
  const host = useRef<HTMLDivElement>(null)
  const current = useRef<EditorSession | null>(null)
  const latest = useRef({ app, draft, props })
  latest.current = { app, draft, props }
  const [editor, setEditor] = useState<SuperDoc | null>(null)
  const [editingError, setEditingError] = useState('')
  const [formatFallback, setFormatFallback] = useState(false)
  const [changingDocument, setChangingDocument] = useState(false)
  const [committing, setCommitting] = useState(false)
  const loading = useRef(false)
  const committingRef = useRef(false)
  const revision = useRef(0)
  const captured = useRef(0)
  const lastLocation = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queue = useRef<Promise<boolean>>(Promise.resolve(true))
  const [length, setLength] = useState(() => certificate.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0))
  const showLoading = changingDocument || (!editor && !editingError)
  const editable = Boolean(editor && draft.ready && !draft.saving && !draft.recovery && !app.busy && !changingDocument && !committing)
  const canExport = useMemo(() => app.workspace && wordExportReadiness(app.workspace, certificate.id).allowed,
    [app.workspace, certificate.id])
  const exportable = editable && !draft.dirty && !draft.conflict && !formatFallback && canExport

  function refreshHighlights(session: EditorSession, locate = false) {
    const { elements, selected, filter } = latest.current.app
    session.highlights.refresh({ elements, selected, filter }, session.targets)
    if (locate && selected !== lastLocation.current) {
      lastLocation.current = selected
      if (selected) void session.highlights.locate(selected)
    }
  }

  function captureLatest() {
    clearTimeout(timer.current)
    const task = queue.current.then(async () => {
      const session = current.current
      const version = revision.current
      if (captured.current === version) return true
      if (!session || loading.current) return false
      const snapshot = await readSuperDocBlocks(session.editor, session.ids, session.baseline, session.inputFormat === 'docx')
      if (current.current !== session || revision.current !== version) return false
      session.targets = snapshot.targets
      refreshHighlights(session, true)
      const office = session.native ? {
        bytes: await session.editor.export({ triggerDownload: false }), expectedFileVersion: session.expectedFileVersion,
      } : undefined
      if (current.current !== session || revision.current !== version) return false
      captured.current = version
      latest.current.draft.capture(snapshot.blocks, office)
      setLength(snapshot.blocks.reduce((sum, item) => sum + item.text.length, 0))
      setEditingError('')
      return true
    }).catch(cause => {
      if (current.current) setEditingError(cause instanceof Error ? cause.message : '无法保存本机草稿，请重试。')
      return false
    })
    queue.current = task
    return task
  }

  function onInput() {
    const session = current.current
    if (!session || loading.current) return
    revision.current++
    latest.current.draft.markDirty()
    // 修改后先撤下旧结果，停笔后校验原文并重画。
    session.highlights.refresh({ elements: [], selected: '', filter: 'all' }, new Map())
    session.targets = new Map()
    lastLocation.current = ''
    if (latest.current.app.selected) latest.current.props.onReviewSelect('')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { void captureLatest() }, 360)
  }

  function publishSelection(session: EditorSession) {
    const { selection } = session.editor.ui
    const snapshot = selection.getSnapshot()
    const text = snapshot.quotedText?.trim()
    if (snapshot.empty || !snapshot.target || !text || snapshot.status !== 'ready') {
      latest.current.props.onSelectionChange(undefined)
      return
    }
    const appState = latest.current.app
    const anchored = reviewSelection(snapshot.target, session.targets, appState.certificate?.paragraphs ?? [], appState.elements)
    latest.current.props.onSelectionChange({ text, ...anchored, rect: selection.getRects()[0] })
  }

  useEffect(() => {
    const controller = new AbortController()
    const source = draft.source
    const id = certificate.id
    const mount = host.current
    const paper = mount?.parentElement
    const canvas = paper?.parentElement
    if (!mount || !paper || !canvas) return
    let instance: SuperDoc | undefined
    let cleanup: (() => void) | undefined
    let initialized = false
    let fitFrame = 0
    let initialScrollFrame = 0
    let fitDocument: (() => void) | undefined
    setEditor(null)
    setEditingError('')
    setFormatFallback(false)
    lastLocation.current = ''
    loading.current = true
    revision.current = captured.current = 0
    void (async () => {
      const [{ SuperDoc: Editor }, file] = await Promise.all([
        import('superdoc'),
        source.format === 'docx' ? readDocxWork(id, controller.signal) : undefined,
      ])
      if (controller.signal.aborted) return
      const fallback = source.format === 'docx' && !file
      const inputFormat = fallback ? undefined : source.format
      setFormatFallback(fallback)
      instance = new Editor({
        selector: mount,
        document: file?.bytes,
        documentMode: 'editing',
        ui: { loading: false },
        telemetry: { enabled: false },
        disableContextMenu: true,
        licenseKey: import.meta.env.VITE_SUPERDOC_LICENSE_KEY || undefined,
        onViewportChange: () => fitDocument?.(),
        onContentError: ({ error }) => {
          if (!controller.signal.aborted) setEditingError(error instanceof Error ? error.message : '文书无法打开。')
        },
        onEditorUpdate: onInput,
        onReady: ({ superdoc }) => {
          if (initialized) return
          initialized = true
          void (async () => {
            if (!file) await loadBody(superdoc, source.blocks)
            if (controller.signal.aborted) return
            const ids = new Map<string, string>()
            const projection = await readSuperDocBlocks(superdoc, ids, source.blocks, inputFormat === 'docx')
            if (controller.signal.aborted) return
            const highlights = createReviewHighlights(superdoc, key => latest.current.props.onReviewSelect(key))
            const session: EditorSession = { editor: superdoc, ids, targets: projection.targets,
              baseline: source.blocks, inputFormat, expectedFileVersion: file?.expectedFileVersion ?? source.version,
              native: !fallback && (!source.format || source.format === 'docx' || source.format === 'doc'), highlights }
            current.current = session
            const stopSelection = superdoc.ui.selection.observe(() => publishSelection(session))
            const stopViewport = superdoc.ui.viewport.observe(() => {
              if (!superdoc.ui.selection.getSnapshot().empty) publishSelection(session)
            })
            let initialPosition = true
            fitDocument = () => {
              cancelAnimationFrame(fitFrame)
              fitFrame = requestAnimationFrame(() => {
                if (controller.signal.aborted) return
                const metrics = superdoc.activeEditor?.pageMetrics?.getSnapshot()
                const firstPage = metrics?.pages[0]
                const paperWidth = paper.clientWidth
                if (!paperWidth || !firstPage || !metrics?.widestPageWidthPx) return

                // 只调整屏幕视口。放大正文后居中显示，原页边缘仍可滚动查看。
                const inset = paperWidth >= 560 ? Math.max(0, metrics.pages.reduce((limit, { base }) =>
                  Math.min(limit, base.marginLeftPx / 1.25, base.marginRightPx / 1.25), 64)) : 0
                const zoomLimit = inset ? 125 : 100
                const zoom = Math.max(25, Math.min(zoomLimit, Math.floor((paperWidth + inset * 2) / metrics.widestPageWidthPx * 100)))
                const overflow = Math.max(0, Math.ceil(metrics.widestPageWidthPx * zoom / 100) - paperWidth)
                const nextWidth = overflow ? `calc(100% + ${overflow}px)` : ''
                if (mount.style.width !== nextWidth) {
                  mount.style.width = nextWidth
                  canvas.scrollLeft = overflow / 2
                }
                if (superdoc.getZoomState().value !== zoom) superdoc.setZoom(zoom)
                if (initialPosition) {
                  initialPosition = false
                  initialScrollFrame = requestAnimationFrame(() => {
                    const header = mount.querySelector('.superdoc-page')?.querySelector('.superdoc-page-header, [data-layout-story="header"]')
                    if (!latest.current.app.selected && !canvas.scrollTop && !header?.childElementCount && !header?.textContent?.trim()) {
                      canvas.scrollTop = Math.max(0, firstPage.base.marginTopPx * zoom / 100 - 26)
                    }
                  })
                }
              })
            }
            const resize = new ResizeObserver(fitDocument)
            resize.observe(paper)
            const stopPageMetrics = superdoc.activeEditor?.pageMetrics?.subscribe(fitDocument)
            fitDocument()
            cleanup = () => {
              resize.disconnect()
              stopPageMetrics?.()
              stopSelection()
              stopViewport()
              session.highlights.dispose()
              mount.style.width = ''
            }
            latest.current.props.onClearSelectionReady(() => {
              const range = superdoc.ui.selection.getSnapshot().selectionTarget
              if (range) superdoc.ui.selection.apply({ ...range, start: range.end })
            })
            superdoc.setDocumentMode('viewing')
            loading.current = false
            refreshHighlights(session, true)
            setLength(projection.blocks.reduce((sum, item) => sum + item.text.length, 0))
            setEditor(superdoc)
          })().catch(cause => {
            if (!controller.signal.aborted) setEditingError(cause instanceof Error ? cause.message : '文书无法打开。')
          })
        },
      })
    })().catch(cause => {
      if (!controller.signal.aborted) setEditingError(cause instanceof Error ? cause.message : '文书无法打开。')
    })
    return () => {
      controller.abort()
      clearTimeout(timer.current)
      cancelAnimationFrame(fitFrame)
      cancelAnimationFrame(initialScrollFrame)
      current.current = null
      cleanup?.()
      instance?.destroy()
      latest.current.props.onClearSelectionReady(null)
      latest.current.props.onSelectionChange(undefined)
    }
    // 正文或 Word 工作副本版本变化才重新载入，核验状态更新只重画高亮。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.source, certificate.id])

  useEffect(() => { editor?.setDocumentMode(editable ? 'editing' : 'viewing') }, [editor, editable])
  useEffect(() => { if (current.current) refreshHighlights(current.current, true) }, [app.elements, app.selected, app.filter])

  const operations = useRef({ save: async () => false, flush: async () => false })
  operations.current = {
    async save() {
      if (committingRef.current || draft.conflict || draft.recovery) return false
      if (!draft.ready || !draft.dirty) return draft.checkLoadedDraft()
      if (loading.current) return false
      committingRef.current = true
      setCommitting(true)
      current.current?.editor.setDocumentMode('viewing')
      try {
        if (!await captureLatest()) return false
        const saved = await draft.save()
        if (saved && typeof saved !== 'boolean' && current.current) {
          current.current.expectedFileVersion = saved.officeFile?.sha256 ?? 'none'
          current.current.baseline = contentSnapshot(saved.paragraphs)
        }
        return Boolean(saved)
      } finally {
        committingRef.current = false
        setCommitting(false)
      }
    },
    async flush() { return await captureLatest() && await draft.flush() },
  }
  useEffect(() => registerDocumentGuard(async mode => {
    if (mode === 'draft') return operations.current.flush()
    const saved = await operations.current.save()
    if (!saved) toast('请先处理当前文书的草稿或保存提示')
    return saved
  }), [registerDocumentGuard, toast])
  useEffect(() => {
    const flush = (event: Event) => {
      const done = (event as CustomEvent<(saved: boolean) => void>).detail
      if (typeof done !== 'function') return
      event.preventDefault()
      void operations.current.flush().then(done, () => done(false))
    }
    window.addEventListener('lawverify:flush-document-draft', flush)
    return () => window.removeEventListener('lawverify:flush-document-draft', flush)
  }, [])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void operations.current.save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const restore = async () => {
    const session = current.current
    if (!session || loading.current) return
    loading.current = true
    setChangingDocument(true)
    let recapture = false
    try {
      await draft.restore(async saved => {
        const blocks = JSON.parse(saved.text) as DocumentBlock[]
        if (saved.office) {
          await replaceEditorFile(session.editor, saved.office.bytes)
          session.expectedFileVersion = saved.office.expectedFileVersion
          session.inputFormat = 'docx'
          session.native = true
          setFormatFallback(false)
          session.highlights.dispose()
          session.highlights = createReviewHighlights(session.editor, key => latest.current.props.onReviewSelect(key))
        } else {
          session.editor.setDocumentMode('editing')
          if (session.inputFormat === 'docx') await restoreLegacyWord(session, blocks)
          else await loadBody(session.editor, blocks)
          recapture = session.native
        }
        session.ids = new Map()
        const snapshot = await readSuperDocBlocks(session.editor, session.ids, blocks, session.inputFormat === 'docx')
        session.targets = snapshot.targets
        refreshHighlights(session)
        setLength(snapshot.blocks.reduce((sum, item) => sum + item.text.length, 0))
      })
    } finally {
      session.editor.setDocumentMode('viewing')
      loading.current = false
      setChangingDocument(false)
    }
    if (recapture) { revision.current++; void captureLatest() }
  }

  return <section className="document-editor-inline" aria-label="文书编辑区">
    <div className="document-editor-tools">
      {editor && <DocumentToolbar editor={editor} disabled={!editable} />}
      <Button className="document-save-button" disabled={!draft.dirty || !editable || draft.conflict}
        onClick={() => void operations.current.save()}><Save size={14} />{draft.saving || committing ? '正在保存…' : '保存文书'}</Button>
      <div className="document-export-actions" role="group" aria-label="文书导出">
        <Button variant="outline" className="workspace-report-button" disabled={app.busy}
          onClick={async () => {
            if (await app.prepareDocument()) { app.setAssistantRequest(null); app.setPage('report') }
          }}>导出文书</Button>
        <Button variant="outline" disabled={!exportable} onClick={() => void app.exportWord('original')}>导出原格式</Button>
      </div>
    </div>
    <div className="document-editor-notices">
      {formatFallback && <div className="document-editor-notice">当前正文无法与 Word 原件的结构对齐。可继续编辑正文，Word 原件已保留。</div>}
      {draft.recovery && <div className="document-editor-notice">发现未提交的文书草稿。
        <Button variant="outline" disabled={!editor || changingDocument} onClick={() => void restore()}>恢复草稿</Button>
        <Button variant="ghost" disabled={changingDocument} onClick={() => void draft.discardRecovery()}>使用已保存正文</Button></div>}
      {draft.conflict && <div className="document-editor-notice">正文已有更新，请对照后再保存。
        <details><summary>查看最新保存的正文</summary><pre>{certificate.paragraphs.map(paragraph => paragraph.text).join('\n\n')}</pre></details>
        <Button variant="outline" disabled={!editor || Boolean(draft.recovery)} onClick={() => {
          if (current.current) current.current.expectedFileVersion = certificate.officeFile?.sha256 ?? 'none'
          draft.adoptLatestBase()
        }}>已核对，以最新版本为基线继续</Button></div>}
    </div>
    <div className="doc-scroll document-editor-canvas" onClick={event => {
      if (!(event.target instanceof Element) || !host.current?.contains(event.target) || event.target.closest('[data-superdoc-ext-el]')) return
      if (!editor?.ui.viewport.entityAt({ x: event.clientX, y: event.clientY }).some(hit => hit.type === 'decoration')) props.onReviewSelect('')
    }}><article className={`doc-paper document-editor-paper ${app.filter !== 'all' ? 'filtering' : ''} ${app.selected ? 'sel-mode' : ''}`}>
      <div ref={host} className="whole-document-content" data-editable={editable} aria-label="文书正文" inert={showLoading} />
      {showLoading && <div className="document-editor-loading">
        <div role="status">
          <h2>正在加载文书</h2>
          <p>{changingDocument ? '正在恢复草稿…' : '正在打开文书…'}</p>
          <label>加载进度<progress /></label>
        </div>
      </div>}
    </article></div>
    <footer className="document-editor-status"><span role="status" className={draft.draftError || editingError ? 'draft-error' : ''}>
      {editingError || draft.notice || (editor && draft.ready ? '正文已同步' : '正在读取文书…')}</span>
      <span>{length.toLocaleString()} 字</span></footer>
  </section>
}
