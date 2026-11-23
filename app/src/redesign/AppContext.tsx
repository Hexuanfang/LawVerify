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
import type { DeclarationEditAction, DeclarationReviewAction, SkippedVerificationMaterial } from '../../../server/src/intelligence/verification/protocol'
import { declarationEditRange } from '../../../server/src/intelligence/verification/review-status.ts'
import { reviewReadiness, reanchorParagraph } from './workflow'
import { endSession, useSession } from './session'
import {
  paragraphElements as buildParagraphElements,
  buildProjects,
  counts,
  needsVerification,
  statementRanges,
  type ReviewElement,
  type Source,
} from './model'
import { exportDocument } from './services'
import { useWorkspace } from './useWorkspace'
import { replaceRichText } from './richText'
import { VERIFICATION_STEPS, verificationStep } from './verificationProgress'
import { appendReviewAudit, readCaseAssistantAudits, readReviewAudits, type ReviewAudit } from './review-audit-store'

type VerificationPreparation = (signal: AbortSignal, report: (message: string, title: string, step?: 0 | 1) => void) => Promise<Array<{ id: string; title: string }>>
type CaseSetupProgress = { title: string; openDraft?: () => void }

type Page = 'home' | 'ws' | 'proc' | 'report' | 'lib'
export type LibTab = 'law' | 'case' | 'proj' | 'acct'
export type FormState = { tab: Exclude<LibTab, 'acct'>; id?: string } | null
export type Audit = Pick<ReviewAudit, 't' | 'msg' | 'elementId' | 'certificateId'>
const emptyReview = { total: 0, unreviewed: 0, red: 0, ready: false }

function useAppState() {
  const data = useWorkspace()
  const { workspace, mutate, setError } = data
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
  const [assistantRequest, setAssistantRequest] = useState<{
    mode: 'case' | 'document' | 'law' | 'similar' | 'report' | 'rewrite'
    prompt?: string
    quote?: string
    anchor?: import('../../../server/src/intelligence/verification/rewrite-selection').RewriteSelection
    declarationIds?: string[]
  } | null>(null)
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
  const [audits, setAudits] = useState<ReviewAudit[]>([])
  const account = sessionStorage.getItem('lawverify-login-account') || ''
  useEffect(() => {
    let live = true
    if (account && (docId || caseId)) void Promise.all([
      docId ? readReviewAudits(account, docId) : [],
      caseId ? readCaseAssistantAudits(account, caseId) : [],
    ]).then(results => {
      const items = results.flat()
      if (live) setAudits(current => [...items, ...current.filter(item => !items.some(saved => saved.id === item.id))])
    }).catch(() => {
      if (live) setError('本机操作记录读取失败，请重新打开文书后重试。')
    })
    return () => { live = false }
  }, [account, docId, caseId, setError])
  const [proc, setProc] = useState<{
    step: number; message: string; error: string; done: boolean; title?: string; draft?: boolean
    skippedMaterials?: SkippedVerificationMaterial[]
  }>({
    step: 0,
    message: '',
    error: '',
    done: false,
  })
  const abort = useRef<AbortController | null>(null)
  const pendingVerification = useRef<string[]>([])
  const pendingPreparation = useRef<VerificationPreparation | undefined>(undefined)
  const pendingScope = useRef<'dirty' | undefined>(undefined)
  const pendingCaseSetup = useRef<CaseSetupProgress | undefined>(undefined)
  const processingMounted = useRef(false)
  const processingReady = useRef<(() => void) | null>(null)
  const onProcessingMounted = useCallback(() => {
    processingMounted.current = true
    processingReady.current?.()
    return () => { processingMounted.current = false }
  }, [])
  const onLeaving = useCallback(() => abort.current?.abort(), [])
  const [cloudProfile, setCloudProfile] = useState<Awaited<ReturnType<typeof api.getCloudProfile>>>()
  useSession(onLeaving, setCloudProfile)
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
  const projectId = project?.id
  const certificateId = certificate?.id
  const caseReview = useMemo(() => page === 'ws' && workspace && projectId ? reviewReadiness(workspace, projectId) : emptyReview,
    [page, workspace, projectId])
  const documentReview = useMemo(() => page === 'report' && workspace && projectId && certificateId
    ? reviewReadiness(workspace, projectId, certificateId) : emptyReview, [page, workspace, projectId, certificateId])

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
      setAssistantRequest(null)
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
    setAssistantRequest(null)
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

  const addAudit = async (target: Pick<ReviewElement, 'id' | 'paragraphId' | 'certificateId'>, text: string) => {
    const audit: ReviewAudit = {
      id: crypto.randomUUID(), account, t: new Date().toISOString(), msg: text,
      elementId: target.id, paragraphId: target.paragraphId, certificateId: target.certificateId,
      caseId: project?.id,
    }
    try {
      await appendReviewAudit(audit)
      if (account === sessionStorage.getItem('lawverify-login-account')) setAudits(current => [...current, audit])
    } catch {
      data.setError('操作已保存，但本机操作记录写入失败，请检查本机存储空间。')
    }
  }
  const auditAssistantAction = (certificateId: string | undefined, text: string, target?: { id: string; paragraphId: string }) => {
    if (!project || !account) return
    return addAudit({ certificateId: certificateId ?? '', id: target?.id ?? '', paragraphId: target?.paragraphId ?? '' }, text)
  }
  const reviewDeclaration = async (target: ReviewElement, action: Pick<DeclarationReviewAction, 'type' | 'note' | 'checks'>, message: string) => {
    if (!target.declaration || !await prepareDocument()) return false
    return run(() => api.reviewDeclaration(target.certificateId, target.paragraphId, {
      ...action, id: crypto.randomUUID(), declarationId: target.id, revision: target.verificationRevision ?? null,
      reviewRevision: target.declaration?.review?.revision ?? null,
    }), message)
  }
  const applyDeclarationEdit = async (target: ReviewElement, type: DeclarationEditAction['type']) => {
    if (!target.declaration || !await prepareDocument()) return false
    const { original } = target
    const range = declarationEditRange(original.text, target.declaration, type)
    if (!range) { setError('声明或已核建议已变化，请重新打开核验卡。'); return false }
    const text = original.text.slice(0, range.start) + range.replacement + original.text.slice(range.end)
    const saved = await run(() => api.editDeclaration(target.certificateId, target.paragraphId,
      reanchorParagraph(original, text, replaceRichText(original.richText, original.text, text, range)), {
        text: original.text, richText: original.richText, links: original.links?.length ? original.links : original.link ? [original.link] : [],
        references: original.references ?? [],
      }, { id: crypto.randomUUID(), declarationId: target.id, type, revision: target.verificationRevision ?? null,
        reviewRevision: target.declaration?.review?.revision ?? null }), type === 'adopt' ? '建议已采纳，正在准备局部重核' : '缺源声明已删除，正在准备局部重核')
    if (saved) void verify(target.certificateId, undefined, 'dirty')
    return saved
  }
  const saveNote = async (target: ReviewElement, note: string) => {
    if (target.declaration) return reviewDeclaration(target, { type: 'note', note }, '声明批注已保存')
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
    if (saved) await addAudit(target, '添加人工批注')
    return saved
  }
  const confirm = async (target: ReviewElement, wholeParagraph = false, checks?: DeclarationReviewAction['checks']) => {
    if (target.verified && (!target.declaration || target.declaration.review?.decision === 'confirmed')) return
    if (target.declaration && !wholeParagraph) {
      await reviewDeclaration(target, { type: 'confirm', checks }, '声明已确认')
      return
    }
    if (!workspace || needsVerification(workspace, target.certificateId)) { toast('当前正文或材料已更新，请先重新核验。'); return }
    const paragraphElements = elements.filter(item => item.paragraphId === target.paragraphId)
    if (paragraphElements.some(item => item.verdict === 'fail' || item.verdict === 'miss')) {
      toast('本段仍有红灯或缺源声明，请处理后再确认整段。')
      return
    }
    if (paragraphElements.length > 1 && !wholeParagraph) { setConfirmation(target); return }
    if (await run(async () => { await assertReferenceSnapshot(target); return api.updateParagraph(target.certificateId, target.paragraphId, { verified: true },
      { text: target.original.text, richText: target.original.richText }) }, '本段全部声明已确认')) {
      await addAudit(target, '律师确认整段全部声明')
      setConfirmation(null)
    }
  }
  const reject = async (target: ReviewElement) => {
    if (target.declaration) {
      await reviewDeclaration(target, { type: 'reject' }, '声明已驳回，待重新核验')
      return
    }
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
      await addAudit(target, '取消整段确认并记录驳回意见')
  }
  const edit = async (target: Pick<ReviewElement, 'id' | 'certificateId' | 'paragraphId' | 'start' | 'end' | 'quote' | 'original' | 'sentenceIndex'>,
    text: string, quiet = false) => {
    if (!text.trim()) {
      toast('声明不能为空')
      return undefined
    }
    const original = target.original
    if (original.text.slice(target.start, target.end) !== target.quote) {
      toast('原声明定位已变化，请刷新后重试')
      return undefined
    }
    if (text === target.quote) return original
    const nextText =
      original.text.slice(0, target.start) +
      text +
      original.text.slice(target.end)
    if (nextText === original.text && text !== target.quote) {
      toast('未找到原声明，请刷新文书后重试')
      return undefined
    }
    let updatedParagraph: typeof original | undefined
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
      const { workspace: updated } = await api.updateParagraph(
        target.certificateId,
        target.paragraphId,
        {
          text: nextText,
          richText: replaceRichText(original.richText, original.text, nextText, { start: target.start, end: target.end, replacement: text }),
          verified: false,
          links,
          link: links[0],
          references: original.references?.map(shiftedAnchor),
        },
        { text: original.text, richText: original.richText,
          links: original.links?.length ? original.links : original.link ? [original.link] : [], references: original.references ?? [] },
      )
      updatedParagraph = updated.certificates.find(item => item.id === target.certificateId)?.paragraphs.find(item => item.id === target.paragraphId)
      if (!workspace?.certificates.find(item => item.id === target.certificateId)?.verification) {
        await api.reviewParagraph(target.certificateId, target.paragraphId)
      }
    }, quiet ? undefined : '声明已保存，可重新核验')
    if (saved) await addAudit(target, '修改声明，待重新核验')
    return saved ? updatedParagraph : undefined
  }
  const applyAssistantRewrite = async (target: Pick<ReviewElement, 'id' | 'certificateId' | 'paragraphId' | 'start' | 'end' | 'quote' | 'original'>,
    candidate: string, version: string) => {
    const original = target.original
    const text = original.text.slice(0, target.start) + candidate + original.text.slice(target.end)
    let status: 'complete' | 'pending' | undefined
    let elementId = ''
    if (!await run(async () => {
      const result = await api.updateParagraph(target.certificateId, target.paragraphId, { text },
        undefined, { start: target.start, quote: target.quote, candidate, version, confirmed: true })
      status = result.assistantRecheck ?? 'pending'
      const document = result.workspace.certificates.find(item => item.id === target.certificateId)
      const paragraph = document?.paragraphs.find(item => item.id === target.paragraphId)
      if (paragraph) {
        const elements = buildParagraphElements(paragraph, result.workspace, target.certificateId)
        elementId = (elements.find(item => item.start < target.start + candidate.length && item.end > target.start) ?? elements[0])?.id ?? ''
      }
    })) return undefined
    select(elementId)
    return status
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
          }, { text: target.original.text, richText: target.original.richText, links: old, references: target.original.references ?? [] }),
        '已保存新出处，请复核定位',
      )
    )
      await addAudit(target, '重新关联出处')
  }
  const verify = useCallback(
    async (documents: string | string[] = docId, preparation?: VerificationPreparation, scope?: 'dirty', caseSetup?: CaseSetupProgress) => {
      if (abort.current) return
      let ids = [...new Set((Array.isArray(documents) ? documents : [documents]).filter(Boolean))]
      if (!ids.length && !preparation) {
        toast('请先导入待核验文书')
        return
      }
      const titles = new Map(workspace?.certificates.map(item => [item.id, item.title]))
      setPage('proc')
      setProc({ step: 0, title: caseSetup?.title, draft: Boolean(caseSetup?.openDraft),
        message: preparation ? (caseSetup ? '正在准备案件' : '准备导入核验文件') : '准备读取材料解析状态', error: '', done: false })
      const controller = new AbortController()
      abort.current = controller
      pendingVerification.current = [...ids]
      pendingPreparation.current = preparation
      pendingScope.current = scope
      pendingCaseSetup.current = caseSetup
      const skippedMaterials = new Map<string, SkippedVerificationMaterial>()
      const result = await run(async () => {
        await import('./Report')
        controller.signal.throwIfAborted()
        if (caseSetup && !processingMounted.current) {
          await new Promise<void>(resolve => {
            const ready = () => {
              controller.signal.removeEventListener('abort', ready)
              processingReady.current = null
              resolve()
            }
            processingReady.current = ready
            controller.signal.addEventListener('abort', ready, { once: true })
          })
          controller.signal.throwIfAborted()
        }
        if (preparation) {
          const imported = await preparation(controller.signal, (message, title, step = 0) => {
            setProc(current => ({ ...current, step, message, title }))
          })
          ids = [...new Set(imported.map(item => item.id))]
          controller.signal.throwIfAborted()
          if (caseSetup?.openDraft) return
          imported.forEach(item => titles.set(item.id, item.title))
          pendingVerification.current = [...ids]
          pendingPreparation.current = undefined
          if (!ids.length) throw new Error('没有可核验的文书，请重新导入。')
        }
        for (const [index, id] of ids.entries()) {
          controller.signal.throwIfAborted()
          setDocId(id)
          select('')
          setProc(current => ({ ...current, step: 0, title: titles.get(id), message: `正在核验第 ${index + 1}/${ids.length} 份文书` }))
          const outcome = await api.autoLinkCertificate(id, text => {
            const step = verificationStep(text)
            setProc(current => ({ ...current, step: Math.max(current.step, step), message: `第 ${index + 1}/${ids.length} 份 · ${text}` }))
          }, controller.signal, scope)
          for (const item of outcome.linkage.certificate.verification?.skippedMaterials ?? []) {
            skippedMaterials.set(item.evidenceId, item)
          }
          const recorded = [...skippedMaterials.values()]
          setProc(current => ({ ...current, skippedMaterials: recorded }))
          pendingVerification.current = ids.slice(index + 1)
        }
      })
      if (abort.current !== controller) return
      if (result) {
        pendingPreparation.current = undefined
        pendingCaseSetup.current = undefined
        if (caseSetup?.openDraft) caseSetup.openDraft()
        else {
          setProc(current => ({ ...current, step: VERIFICATION_STEPS.length, title: titles.get(ids[ids.length - 1]),
            message: ids.length > 1 ? `全部 ${ids.length} 份文书核验完成` : '核验完成', error: '', done: true }))
          setDocId(ids[ids.length - 1])
          select('')
        }
      } else {
        if (controller.signal.aborted) setError('')
        const importing = Boolean(pendingPreparation.current)
        setProc(current => ({
          ...current,
          error: importing && caseSetup
            ? controller.signal.aborted ? '已停止等待案件文件处理，可重试。' : '案件文件处理未完成，请查看错误提示后重试。'
            : importing
            ? controller.signal.aborted ? '文书导入已取消，重试将继续导入并核验。' : '文书导入未完成，重试将继续导入并核验。'
            : controller.signal.aborted
              ? `核验已取消，剩余 ${pendingVerification.current.length} 份文书待核验。重试将继续处理剩余文书。`
              : `核验未完成，剩余 ${pendingVerification.current.length} 份文书待核验。重试将从失败文书继续。`,
        }))
      }
      abort.current = null
    },
    [docId, run, toast, workspace?.certificates, setError],
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
    if (!paragraph.verified && needsVerification(workspace, certificate.id)) { toast('当前正文或材料已更新，请先重新核验。'); return }
    if (!paragraph.verified && buildParagraphElements(paragraph, workspace, certificate.id).some(item => item.verdict === 'fail' || item.verdict === 'miss')) {
      toast('本段仍有红灯或缺源，请先处理后确认。'); return
    }
    const saved = await run(async () => {
      const latest = (await api.getWorkspace()).workspace.certificates.find(item => item.id === certificate.id)?.paragraphs.find(item => item.id === paragraph.id)
      if (!latest || JSON.stringify(latest) !== JSON.stringify(paragraph)) throw new Error('段落内容或引用已有更新，请核对最新内容后再次确认。')
      if (paragraph.verified) await invalidateCaseReview()
      await api.updateParagraph(certificate.id, paragraph.id, { verified: !paragraph.verified }, { text: paragraph.text, richText: paragraph.richText })
    }, paragraph.verified ? '已取消本段确认' : '已确认本段全部内容')
    if (saved) await addAudit({ id: `${certificate.id}:${paragraph.id}:paragraph`, paragraphId: paragraph.id, certificateId: certificate.id },
      paragraph.verified ? '取消整段确认' : '律师确认整段全部声明')
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
      await api.updateParagraph(certificate.id, paragraph.id, reanchorParagraph(latest, text, richText), { ...expected,
        links: latest.links?.length ? latest.links : latest.link ? [latest.link] : [], references: latest.references ?? [] })
    }, '段落已保存，正文变更后请重新核验')
  }
  const assertReferenceSnapshot = async (target: Pick<ReviewElement, 'certificateId' | 'paragraphId' | 'original'>) => {
    const latest = (await api.getWorkspace()).workspace.certificates.find(item => item.id === target.certificateId)?.paragraphs.find(item => item.id === target.paragraphId)
    if (!latest) throw new Error('段落已不存在，请重新打开文书。')
    const sources = (paragraph: CertificateParagraph) => JSON.stringify({ links: paragraph.links ?? [], link: paragraph.link, references: paragraph.references ?? [] })
    if (sources(latest) !== sources(target.original)) throw new Error('该段引用已有更新，请关闭引用管理后重新打开，核对后再保存。')
    return latest
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
      const oldIds = new Set([...oldLinks, ...(target.original.references ?? [])].map(source => source.id))
      const sourceIds = [...(links ?? []), ...(patch.references ?? [])].flatMap(source => source.id && !oldIds.has(source.id) ? [source.id] : [])
      await api.updateParagraph(target.certificateId, target.paragraphId, { ...patch, ...(links ? { links, link: links[0] } : {}), verified: false },
        { text: target.original.text, richText: target.original.richText, links: oldLinks, references: target.original.references ?? [] }, undefined,
        target.declaration ? { id: crypto.randomUUID(), declarationId: target.id, revision: target.verificationRevision ?? null,
          reviewRevision: target.declaration.review?.revision ?? null, sourceIds } : undefined)
    }, '引用已保存，请重新审阅本段')
    if (saved && !target.declaration) await addAudit(target, '维护段落引用')
    return saved
  }
  const exportWord = async (mode: Parameters<typeof exportDocument>[2]) => {
    if (!workspace || !certificate) return
    try {
      if (!(await prepareDocument())) return
      const { workspace: snapshot } = await api.getWorkspace()
      await exportDocument(snapshot, certificate.id, mode)
      toast({ review: '已导出审阅版 Word', clean: '已导出清洁版与核验记录', original: '文书已导出' }[mode])
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
    assistantRequest, setAssistantRequest, auditAssistantAction,
    updateMaterial, deleteMaterial, markCaseReady, saveParagraph, saveDocument, saveReferences,
    invalidateCaseReview,
    cloudProfile, setCloudProfile,
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
    audits: audits.filter(item => item.account === account.trim().toLowerCase()),
    saveNote,
    confirm,
    reject,
    toggleWarning: (target: ReviewElement) => reviewDeclaration(target, { type: target.ignored ? 'restore-warning' : 'ignore' },
      target.ignored ? '预警已恢复到待办' : '预警已忽略，报告仍保留记录'),
    declineSuggestion: (target: ReviewElement) => reviewDeclaration(target, { type: 'decline' }, '已记录拒绝建议'),
    applyDeclarationEdit,
    edit,
    applyAssistantRewrite,
    relink,
    proc,
    onProcessingMounted,
    verify,
    recheckDirty: () => verify(docId, undefined, 'dirty'),
    retryVerification: () => verify(pendingVerification.current, pendingPreparation.current, pendingScope.current, pendingCaseSetup.current),
    cancelVerification: () => abort.current?.abort(),
    exportWord,
    setCaseIdForUpload: (id: string, documentId: string, openWorkspace = true) => {
      if (id !== project?.id) setAssistantRequest(null)
      setCaseId(id)
      setDocId(documentId)
      select('')
      setFilter('all')
      if (openWorkspace) setPage('ws')
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
