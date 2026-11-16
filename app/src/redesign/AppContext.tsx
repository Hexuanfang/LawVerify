import type { DocumentBlock } from './documentContent'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from '../api'
import type { CertificateParagraph } from '../types'
import { reviewReadiness, reanchorParagraph } from './workflow'
import { endSession, useSession } from './session'
import {
  paragraphElements as buildParagraphElements,
  buildProjects,
  counts,
  statementRanges,
  type ReviewElement,
  type Source,
} from './model'
import { exportDocument } from './services'
import { useWorkspace } from './useWorkspace'
import { replaceRichText } from './richText'

type Page = 'home' | 'ws' | 'proc' | 'report' | 'lib'
export type LibTab = 'law' | 'case' | 'proj' | 'acct'
export type FormState = { tab: Exclude<LibTab, 'acct'>; id?: string } | null
export type Audit = {
  t: string
  msg: string
  elementId: string
  certificateId: string
}

function useAppState() {
  const data = useWorkspace()
  const { workspace, mutate } = data
  const [reviewListOpen, setReviewListOpen] = useState(false)
  const documentGuard = useRef<((mode: 'save' | 'draft') => Promise<boolean>) | null>(null)
  const registerDocumentGuard = useCallback((guard: (mode: 'save' | 'draft') => Promise<boolean>) => {
    documentGuard.current = guard
    return () => { if (documentGuard.current === guard) documentGuard.current = null }
  }, [])
  const prepareDocument = useCallback(async () => {
    if (data.busy) return false
    return documentGuard.current ? documentGuard.current('save') : true
  }, [data.busy])
  const flushDocument = useCallback(async () => {
    if (data.busy) return false
    return documentGuard.current ? documentGuard.current('draft') : true
  }, [data.busy])
  const [referenceTarget, setReferenceTarget] = useState<ReviewElement | null>(null)
  const [confirmation, setConfirmation] = useState<ReviewElement | null>(null)
  const [page, setPage] = useState<Page>('home')
  const [caseId, setCaseId] = useState('')
  const [docId, setDocId] = useState('')
  const [selected, select] = useState('')
  const [filter, setFilter] = useState('all')
  const [libTab, setLibTab] = useState<LibTab>('law')
  const [uploadCase, setUploadCase] = useState<string | null>(null)
  const [documentCase, setDocumentCase] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(null)
  const [drawer, setDrawer] = useState<Source | null>(null)
  const [message, setMessage] = useState('')
  const [audits, setAudits] = useState<Audit[]>([])
  const [proc, setProc] = useState({
    step: 0,
    message: '',
    error: '',
    done: false,
  })
  const abort = useRef<AbortController | null>(null)
  const onLeaving = useCallback(() => abort.current?.abort(), [])
  useSession(onLeaving)
  const projects = useMemo(
    () => (workspace ? buildProjects(workspace) : []),
    [workspace],
  )
  const project = projects.find((item) => item.id === caseId) ?? projects[0]
  const certificate = workspace?.certificates.find(
    (item) => item.id === docId && item.caseId === project?.id,
  )
  const elements = project?.els[docId] ?? []
  const element = elements.find((item) => item.id === selected)
  const stats = counts(elements)
  const caseReview = workspace && project ? reviewReadiness(workspace, project.id) : { total: 0, unreviewed: 0, red: 0, ready: false }
  const documentReview = workspace && certificate ? reviewReadiness(workspace, certificate.caseId, certificate.id) : { total: 0, unreviewed: 0, red: 0, ready: false }

  const enter = useCallback(
    (id: string, requestedDocument?: string) => {
      if (data.busy) return
      const target = projects.find((item) => item.id === id)
      if (!target) return
      const nextDoc =
        requestedDocument && target.docs.includes(requestedDocument)
          ? requestedDocument
          : (target.docs[0] ?? '')
      setCaseId(id)
      setDocId(nextDoc)
      select('')
      setFilter('all')
      setPage('ws')
      localStorage.setItem(
        `lawverify-new-last:${workspace?.user.id}`,
        JSON.stringify({ caseId: id, docId: nextDoc }),
      )
    },
    [projects, workspace?.user.id, data.busy],
  )
  const switchDocument = (id: string) => {
    setDocId(id)
    select('')
    setFilter('all')
  }
  const toast = useCallback((text: string) => {
    setMessage('')
    requestAnimationFrame(() => setMessage(text))
  }, [])
  const run = useCallback(
    async (operation: () => Promise<unknown>, success?: string) => {
      try {
        await mutate(operation)
        if (success) toast(success)
        return true
      } catch {
        return false
      }
    },
    [mutate, toast],
  )

  const addAudit = (target: ReviewElement, text: string) => {
    setAudits((current) => [
      ...current,
      {
        t: new Date().toISOString(),
        msg: text,
        elementId: target.id,
        certificateId: target.certificateId,
      },
    ])
  }
  const saveNote = async (target: ReviewElement, note: string) => {
    const saved = await run(
      () =>
        api.updateParagraph(
          target.certificateId,
          target.paragraphId,
          { note },
          { text: target.original.text, richText: target.original.richText },
        ),
      '批注已保存',
    )
    if (saved) addAudit(target, '添加人工批注')
    return saved
  }
  const confirm = async (target: ReviewElement, wholeParagraph = false) => {
    const paragraphElements = elements.filter(item => item.paragraphId === target.paragraphId)
    if (paragraphElements.some(item => item.verdict === 'fail' || item.verdict === 'miss')) {
      toast('本段仍有红灯或缺源声明，请处理后再确认整段。')
      return
    }
    if (paragraphElements.length > 1 && !wholeParagraph) { setConfirmation(target); return }
    if (await run(async () => { await assertReferenceSnapshot(target); return api.updateParagraph(target.certificateId, target.paragraphId, { verified: true },
      { text: target.original.text, richText: target.original.richText }) }, '本段全部声明已确认')) {
      addAudit(target, '律师确认整段全部声明')
      setConfirmation(null)
    }
  }
  const reject = async (target: ReviewElement) => {
    if (
      await run(
        async () => {
          await invalidateCaseReview()
          return api.updateParagraph(target.certificateId, target.paragraphId, {
            verified: false,
            note: `${target.note ? target.note + '\n' : ''}律师驳回 AI 判定，需按人工意见复核。`,
          })
        },
        '已保存驳回意见',
      )
    )
      addAudit(target, '驳回 AI 判定')
  }
  const edit = async (target: ReviewElement, text: string) => {
    if (!text.trim()) {
      toast('声明不能为空')
      return false
    }
    const original = target.original
    if (original.text.slice(target.start, target.end) !== target.quote) {
      toast('原声明定位已变化，请刷新后重试')
      return false
    }
    const nextText =
      original.text.slice(0, target.start) +
      text +
      original.text.slice(target.end)
    if (nextText === original.text && text !== target.quote) {
      toast('未找到原声明，请刷新文书后重试')
      return false
    }
    const saved = await run(async () => {
      const nextRanges = statementRanges(nextText)
      const shiftedAnchor = <
        T extends { sentenceIndex?: number; sentenceText?: string },
      >(
        source: T,
      ): T => {
        if (source.sentenceIndex === undefined) return source
        const oldRange = statementRanges(original.text)[source.sentenceIndex]
        if (!oldRange)
          return {
            ...source,
            sentenceIndex: undefined,
            sentenceText: undefined,
          }
        const start =
          oldRange.start >= target.end
            ? oldRange.start + text.length - target.quote.length
            : oldRange.start
        const nextRange = nextRanges.find(
          (range) => range.start <= start && range.end > start,
        )
        return {
          ...source,
          sentenceIndex: nextRange?.sentenceIndex,
          sentenceText: nextRange?.text,
        }
      }
      const links = (
        original.links?.length
          ? original.links
          : original.link
            ? [original.link]
            : []
      ).map((source) => {
        const updated = shiftedAnchor(source)
        return source.sentenceIndex === target.sentenceIndex
          ? {
              ...updated,
              relation: 'context' as const,
              reason: '声明已修改，待复核。',
            }
          : updated
      })
      await invalidateCaseReview()
      await api.updateParagraph(
        target.certificateId,
        target.paragraphId,
        {
          text: nextText,
          richText: replaceRichText(original.richText, original.text, nextText),
          verified: false,
          links,
          link: links[0],
          references: original.references?.map(shiftedAnchor),
        },
        { text: original.text, richText: original.richText },
      )
      await api.reviewParagraph(target.certificateId, target.paragraphId)
    }, '声明已保存，局部重核完成')
    if (saved) addAudit(target, '修改声明并局部重核')
    return saved
  }
  const relink = async (target: ReviewElement, evidenceId: string) => {
    const old = target.original.links?.length
      ? target.original.links
      : target.original.link
        ? [target.original.link]
        : []
    const other = old.filter(
      (link) => link.sentenceIndex !== target.sentenceIndex,
    )
    const link = {
      evidenceId,
      locator: '待人工定位',
      quote: '',
      sentenceIndex: target.sentenceIndex,
      sentenceText: target.quote,
      relation: 'context' as const,
      note: '人工重新关联，待复核。',
    }
    if (
      await run(
        () =>
          api.updateParagraph(target.certificateId, target.paragraphId, {
            links: [...other, link],
            link: other[0] ?? link,
            verified: false,
          }),
        '已保存新出处，请复核定位',
      )
    )
      addAudit(target, '重新关联出处')
  }
  const verify = useCallback(
    async (id = docId) => {
      if (!id) {
        toast('请先导入待核验文书')
        return
      }
      setPage('proc')
      setProc({
        step: 0,
        message: '准备解析文书与案件原材料',
        error: '',
        done: false,
      })
      const controller = new AbortController()
      abort.current?.abort()
      abort.current = controller
      const result = await run(async () => {
        await api.autoLinkCertificate(
          id,
          (text) => {
            const step = /案例|类案/.test(text)
              ? 4
              : /法条|法律/.test(text)
                ? 3
                : /匹配|证据|材料/.test(text)
                  ? 2
                  : /声明|段落|抽取/.test(text)
                    ? 1
                    : 0
            setProc((current) => ({
              ...current,
              step: Math.max(current.step, step),
              message: text,
            }))
          },
          controller.signal,
        )
      })
      if (abort.current !== controller) return
      if (result) {
        setProc({ step: 6, message: '核验完成', error: '', done: true })
        setDocId(id)
        select('')
        setPage('ws')
      } else
        setProc((current) => ({
          ...current,
          error: controller.signal.aborted
            ? '核验已取消，可返回工作台重试。'
            : '核验未完成，请查看错误信息后重试。',
        }))
      abort.current = null
    },
    [docId, run, toast],
  )
  const invalidateCaseReview = async (evidenceId?: string) => {
    if (!workspace || !project) return
    if (workspace.cases.find(item => item.id === project.id)?.status === 'ready')
      await api.updateCase(project.id, { status: 'in_review' })
    if (evidenceId) {
      for (const doc of workspace.certificates.filter(item => item.caseId === project.id)) {
        for (const paragraph of doc.paragraphs.filter(item => item.verified &&
          (item.links?.length ? item.links : item.link ? [item.link] : []).some(link => link.evidenceId === evidenceId))) {
          await api.updateParagraph(doc.id, paragraph.id, { verified: false })
        }
      }
    }
  }
  const updateMaterial = async (id: string, patch: { name?: string; ocrText?: string }) => {
    const saved = await run(async () => {
      if (patch.ocrText !== undefined) await invalidateCaseReview(id)
      await api.updateEvidence(id, patch)
    }, '材料已保存，正文变更后请重新核验相关声明')
    if (!saved) throw new Error('材料未保存，请查看错误信息后重试。')
  }
  const deleteMaterial = async (id: string) => {
    const saved = await run(async () => {
      await invalidateCaseReview(id)
      await api.deleteEvidence(id)
    }, '材料已删除')
    if (!saved) throw new Error('材料未删除，请重试。')
    setDrawer(null)
    select('')
  }
  const confirmParagraph = async (paragraph: CertificateParagraph) => {
    if (!workspace || !certificate) return
    if (!paragraph.verified && buildParagraphElements(paragraph, workspace, certificate.id).some(item => item.verdict === 'fail' || item.verdict === 'miss')) {
      toast('本段仍有红灯或缺源，请先处理后确认。'); return
    }
    await run(async () => {
      const latest = (await api.getWorkspace()).workspace.certificates.find(item => item.id === certificate.id)?.paragraphs.find(item => item.id === paragraph.id)
      if (!latest || JSON.stringify(latest) !== JSON.stringify(paragraph)) throw new Error('段落内容或引用已有更新，请核对最新内容后再次确认。')
      if (paragraph.verified) await invalidateCaseReview()
      await api.updateParagraph(certificate.id, paragraph.id, { verified: !paragraph.verified }, { text: paragraph.text, richText: paragraph.richText })
    }, paragraph.verified ? '已取消本段确认' : '已确认本段全部内容')
  }
  const markCaseReady = async () => {
    if (!project) return
    await run(async () => {
      const current = (await api.getWorkspace()).workspace
      if (!reviewReadiness(current, project.id).ready) throw new Error('请先审阅全部文书段落并处理红灯，再标记案件完成。')
      await api.updateCase(project.id, { status: 'ready' })
    }, '案件已标记为待归档')
  }
  const saveDocument = async (paragraphs: DocumentBlock[], expected: DocumentBlock[]) => {
    if (!certificate) throw new Error('当前文书已不存在，本机草稿已保留。')
    const result = await mutate(() => api.saveDocumentContent(certificate.id, paragraphs, expected))
    const saved = result.workspace.certificates.find(item => item.id === certificate.id)
    if (!saved) throw new Error('未找到保存后的文书，请保留本机草稿。')
    toast('整篇文书已保存')
    return saved.paragraphs
  }
  const saveParagraph = async (paragraph: CertificateParagraph, text: string, richText: string,
    expected: { text: string; richText?: string } = paragraph) => {
    if (!certificate || !text.trim()) { toast('段落正文不能为空'); return false }
    return run(async () => {
      const latest = (await api.getWorkspace()).workspace.certificates.find(item => item.id === certificate.id)?.paragraphs.find(item => item.id === paragraph.id)
      if (!latest || latest.text !== expected.text || (latest.richText !== undefined && latest.richText !== expected.richText))
        throw new Error('正文已有更新，请保留草稿并核对最新版本。')
      if (text !== latest.text) await invalidateCaseReview()
      await api.updateParagraph(certificate.id, paragraph.id, reanchorParagraph(latest, text, richText), expected)
    }, '段落已保存，正文变更后请重新核验')
  }
  const assertReferenceSnapshot = async (target: ReviewElement) => {
    const latest = (await api.getWorkspace()).workspace.certificates.find(item => item.id === target.certificateId)?.paragraphs.find(item => item.id === target.paragraphId)
    if (!latest) throw new Error('段落已不存在，请重新打开文书。')
    const sources = (paragraph: CertificateParagraph) => JSON.stringify({ links: paragraph.links ?? [], link: paragraph.link, references: paragraph.references ?? [] })
    if (sources(latest) !== sources(target.original)) throw new Error('该段引用已有更新，请关闭引用管理后重新打开，核对后再保存。')
  }
  const saveReferences = async (target: ReviewElement, patch: Partial<CertificateParagraph>) => {
    const saved = await run(async () => {
      await invalidateCaseReview()
      await assertReferenceSnapshot(target)
      const oldLinks = target.original.links?.length ? target.original.links : target.original.link ? [target.original.link] : []
      const links = patch.links?.map((link, index) => {
        const old = link.id ? oldLinks.find(item => item.id === link.id) : oldLinks[index]
        if (link.reason === '人工维护引用关系，请重新审阅。' || (old && old.relation !== link.relation))
          return { ...link, reason: '人工维护引用关系，请重新审阅。' }
        return !old || old.evidenceId !== link.evidenceId || old.locator !== link.locator || old.quote !== link.quote
          ? { ...link, reason: '人工维护引用定位与引文，请重新审阅。' } : link
      })
      await api.updateParagraph(target.certificateId, target.paragraphId, { ...patch, ...(links ? { links, link: links[0] } : {}), verified: false },
        { text: target.original.text, richText: target.original.richText })
    }, '引用已保存，请重新审阅本段')
    if (saved) { addAudit(target, '维护段落引用'); setReferenceTarget(null) }
    return saved
  }
  const exportWord = async (review: boolean) => {
    if (!workspace || !certificate) return
    try {
      await exportDocument(workspace, certificate, review)
      toast(review ? '已导出审阅版 Word' : '已导出清洁版与核验记录')
    } catch (cause) {
      data.setError(cause instanceof Error ? cause.message : '导出失败')
    }
  }
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(''), 3500)
    return () => clearTimeout(timer)
  }, [message])
  useEffect(() => () => abort.current?.abort(), [])

  return {
    ...data,
    reviewListOpen, setReviewListOpen, confirmParagraph,
    caseReview, documentReview, confirmation, setConfirmation,
    registerDocumentGuard, prepareDocument, flushDocument, referenceTarget, setReferenceTarget,
    updateMaterial, deleteMaterial, markCaseReady, saveParagraph, saveDocument, saveReferences,
    invalidateCaseReview,
    logout: () => { onLeaving(); endSession() },
    projects,
    project,
    certificate,
    elements,
    element,
    stats,
    page,
    setPage,
    caseId,
    docId,
    selected,
    select,
    filter,
    setFilter,
    libTab,
    setLibTab,
    documentCase, setDocumentCase,
    uploadCase,
    setUploadCase,
    form,
    setForm,
    drawer,
    setDrawer,
    message,
    toast,
    enter,
    switchDocument,
    run,
    audits,
    saveNote,
    confirm,
    reject,
    edit,
    relink,
    proc,
    verify,
    cancelVerification: () => abort.current?.abort(),
    exportWord,
    setCaseIdForUpload: (id: string, documentId: string) => {
      setCaseId(id)
      setDocId(documentId)
      select('')
      setFilter('all')
      setPage('ws')
    },
  }
}

const Context = createContext<ReturnType<typeof useAppState> | null>(null)
export function AppProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useAppState()}>{children}</Context.Provider>
}
export function useApp() {
  const value = useContext(Context)
  if (!value) throw new Error('页面未挂载 AppProvider')
  return value
}
