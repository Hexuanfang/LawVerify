import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './components/ui/sheet'
import { useApp } from './AppContext'
import { CASE_MATCH_LABELS } from './caseResearchReport'
import { fetchWithWorkspaceAccount, getEvidenceSourceUrl } from '../api'
import { isPlaceholderStatuteContent } from '../../../server/src/intelligence/statute-version'

const caseLevelLabels = {
  guiding: '指导性案例',
  gazette: '公报案例',
  'high-court-reference': '高院参考案例',
  ordinary: '普通案例 · 参考',
}

function highlightCaseExcerpt(text: string, keywords: string[]) {
  const matches = [...new Set(keywords.map(word => word.trim()).filter(word => word && text.includes(word)))]
  if (!matches.length) return text
  const pattern = matches.sort((left, right) => right.length - left.length)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')
  return text.split(new RegExp(`(${pattern})`, 'gu')).map((part, index) =>
    index % 2 ? <mark key={index}>{part}</mark> : part)
}

const PdfPreview = lazy(() =>
  import('../PdfPreview').then((module) => ({ default: module.PdfPreview })),
)
function WordPreview({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void (async () => {
      const response = await fetchWithWorkspaceAccount(url, {
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('原件暂时无法读取')
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > 20 * 1024 * 1024)
        throw new Error('原件超过 20 MB，请打开原件查看。')
      const { renderAsync } = await import('docx-preview')
      if (active && host.current) await renderAsync(bytes, host.current)
    })().catch((cause) => {
      if (active) setError(cause.message)
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [url])
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <div className="new-word-preview" ref={host} />
    </>
  )
}

export function PreviewDrawer() {
  const app = useApp()
  const source = app.drawer
  const isStatute = source?.st === 'l2'
  const caseSource = source?.st === 'l3' ? source : undefined
  const evidence = source?.st === 'l1' ? app.workspace?.evidences.find(
    (item) => item.id === source?.targetId,
  ) : undefined
  const law = isStatute ? app.workspace?.knowledgeStatutes.find(
    (item) =>
      item.id === source?.targetId ||
      item.articles.some((article) => article.id === source?.targetId),
  ) : undefined
  const article = law?.articles.find((item) => item.id === source?.targetId)
  const articleNumber = article?.articleNumber || source?.loc
  const articleText = [article?.plainText, article?.content]
    .find((text) => !isPlaceholderStatuteContent(text))?.trim()
  const quotedText = source?.quote.trim()
  const statuteExcerpt = isPlaceholderStatuteContent(quotedText) ? '' : quotedText
  const matchStart = articleText && statuteExcerpt && statuteExcerpt !== articleText
    ? articleText.indexOf(statuteExcerpt) : -1
  const effectiveDate = law?.effectiveDate?.split('T')[0]
  const effectiveStatus = law?.effectiveStatus === 'effective'
    ? '现行有效' : law?.effectiveStatus === 'repealed' ? '已废止' : '已修正'
  const knowledgeCase = caseSource && app.workspace?.knowledgeCases.find(
    item => item.id === caseSource.targetId || item.excerpts?.some(excerpt => excerpt.id === caseSource.targetId),
  )
  const caseElement = caseSource && app.elements.find(element => element.caseVerification && element.sources.includes(caseSource))
  const caseVerification = caseElement?.caseVerification
  const judgment = caseVerification?.documents?.find(item => item.id === caseSource?.targetId)
  const caseNumber = judgment?.caseNumber || caseVerification?.caseNumber || knowledgeCase?.caseNumber || caseSource?.caseDetails?.caseNumber
  const caseTitle = caseVerification?.name || knowledgeCase?.title || caseSource?.name
  const caseCourt = caseVerification?.court || knowledgeCase?.courtName || caseSource?.caseDetails?.court
  const caseDate = caseVerification?.judgmentDate || knowledgeCase?.judgmentDate || caseSource?.caseDetails?.judgmentDate
  const caseLevel = caseVerification?.level ? caseLevelLabels[caseVerification.level] : caseVerification?.sourceLevel || knowledgeCase?.courtLevel
  const caseType = [knowledgeCase?.caseType, caseTitle].join(' ').match(/(?:民事|刑事|行政|执行|国家赔偿)?(?:判决书|裁定书|调解书|决定书)|支付令/u)?.[0]
    || (/^(?:民事|刑事|行政|执行|国家赔偿)$/u.test(knowledgeCase?.caseType ?? '') ? `${knowledgeCase?.caseType}裁判文书` : '裁判文书')
  const localCaseExcerpt = knowledgeCase?.excerpts?.find(excerpt => excerpt.id === caseSource?.targetId)
  const caseCitation = caseSource?.quote.trim() || ''
  const localCaseText = localCaseExcerpt?.content || knowledgeCase?.holdingSummary
  const caseExcerpt = localCaseText && localCaseText.includes(caseCitation) ? localCaseText : caseCitation
  const caseKeywords = [...(localCaseExcerpt?.keywords ?? []), ...(knowledgeCase?.keywords ?? []),
    ...Array.from(caseElement?.quote.matchAll(/[“「]([^”」]+)[”」]/gu) ?? [], match => match[1])]
  const caseHighlights = caseKeywords.some(word => word.trim() && caseExcerpt.includes(word.trim()))
    ? caseKeywords : [caseCitation !== caseExcerpt ? caseCitation : '']
  const caseMatch = caseVerification?.match
  const caseMatchReason = caseElement?.declaration?.checks.C4?.reason
  const url = evidence ? getEvidenceSourceUrl(evidence.id) : ''
  const evidenceCase = evidence && app.projects.find(project => project.id === evidence.caseId)
  const references = evidence ? (app.workspace?.certificates ?? [])
    .filter(document => document.caseId === evidence.caseId)
    .flatMap(document => {
      const reviewedParagraphs = new Set((evidenceCase?.els[document.id] ?? [])
        .filter(element => element.sources.some(item => item.st === 'l1' && item.targetId === evidence.id))
        .map(element => element.paragraphId))
      const paragraphs = document.paragraphs.flatMap((paragraph, index) => {
        const links = paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []
        return reviewedParagraphs.has(paragraph.id) || links.some(link => link.evidenceId === evidence.id)
          ? [{ id: paragraph.id, number: index + 1, text: paragraph.text }]
          : []
      })
      return paragraphs.length ? [{ id: document.id, title: document.title, paragraphs }] : []
    }) : []
  return (
    <Sheet
      open={Boolean(source)}
      onOpenChange={(open) => {
        if (!open) app.setDrawer(null)
      }}
    >
      <SheetContent className={isStatute ? 'new-drawer statute-drawer' : caseSource ? 'new-drawer case-drawer' : 'new-drawer'} side="right">
        <SheetHeader className={evidence ? 'dwh evidence-drawer-title' : 'dwh'}>
          <SheetTitle className="dwt" asChild={Boolean(evidence)}>
            {evidence ? <h1 title={source?.name}>{source?.name}</h1> : law?.title || caseNumber || source?.name}
          </SheetTitle>
          {evidence ? <SheetDescription className="sr-only">案件原材料</SheetDescription> : (
            <SheetDescription className="dws">
              {caseSource ? ['L3', caseSource.loc || [caseCourt, caseDate].filter(Boolean).join(' · ') || '案例资料'].join(' · ') : (
                <>{isStatute ? '法条' : 'L1 案件原材料'}{articleNumber && ` · ${articleNumber}`}</>
              )}
            </SheetDescription>
          )}
        </SheetHeader>
        <div className="dwb">
          {evidence ? (
            <>
              <section aria-labelledby="evidence-preview-heading">
                <div className="evidence-preview-heading">
                  <h2 id="evidence-preview-heading">原件预览</h2>
                  <a href={url} target="_blank" rel="noreferrer">打开原件 ↗</a>
                </div>
                <div className="pv-stage evidence-preview-content" role="region" aria-label="原件内容" tabIndex={0}>
                  <Suspense fallback={<p role="status">正在加载原件…</p>}>
                    {evidence.type === 'pdf' ? (
                      <PdfPreview sourceUrl={url} name={evidence.name} />
                    ) : evidence.type === 'image' ? (
                      <img className="source-image" src={url} alt={evidence.name} />
                    ) : evidence.type === 'word' && /\.docx$/i.test(evidence.fileName) ? (
                      <WordPreview url={url} />
                    ) : (
                      <div className="pv-paper">
                        <pre>{evidence.ocrText || '材料正在解析，完成后可查看原文。'}</pre>
                      </div>
                    )}
                  </Suspense>
                </div>
              </section>
              <section className="evidence-references" aria-labelledby="evidence-references-heading">
                <h2 id="evidence-references-heading">引用文书与段落</h2>
                {references.length ? references.map(document => (
                  <div className="evidence-reference-document" key={document.id}>
                    <h3>{document.title}</h3>
                    <ul role="list">
                      {document.paragraphs.map(paragraph => (
                        <li key={paragraph.id}>
                          <strong>第 {paragraph.number} 段</strong>
                          <p>{paragraph.text}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )) : <p className="evidence-references-empty">暂无文书引用此材料</p>}
              </section>
            </>
          ) : <div className="pv-stage">
            {isStatute ? (
              <article className="pv-paper statute">
                <h3 className="st-a">{articleNumber || '法条内容'}</h3>
                {law && <p className="statute-preview-meta">
                  <strong className={law.effectiveStatus === 'effective' ? 'text-pass' : 'text-fail'}>{effectiveStatus}</strong>
                  {effectiveDate && <span>{effectiveDate} 施行</span>}
                  {law.issuer && <span>{law.issuer}</span>}
                  {law.version && <span>{law.version}</span>}
                </p>}
                {!articleText && statuteExcerpt && <p className="statute-preview-label">核验引用摘录</p>}
                <p className="st-x">
                  {articleText && statuteExcerpt && matchStart >= 0 ? <>
                    {articleText.slice(0, matchStart)}<mark>{statuteExcerpt}</mark>{articleText.slice(matchStart + statuteExcerpt.length)}
                  </> : articleText || statuteExcerpt || (law && !article ? '请选择具体条号查看原文。' : '暂无可预览的条文。')}
                </p>
              </article>
            ) : caseSource ? (
              <article className="pv-paper casepv">
                <h3 className="st-t">{caseTitle}</h3>
                <p className="st-n">{caseType}</p>
                <div className="four">
                  {[
                    ['案号', caseNumber],
                    ['审理法院', caseCourt],
                    ['裁判日期', caseDate],
                    ['效力层级', caseLevel],
                  ].map(([label, value]) => (
                    <div key={label}><b>{label}</b><span>{value || '未提供'}</span></div>
                  ))}
                </div>
                <blockquote className="csq">
                  {caseExcerpt ? highlightCaseExcerpt(caseExcerpt, caseHighlights) : '暂无可预览的裁判摘录。'}
                </blockquote>
                {caseMatch && <div className="pt"><div>
                  <span data-match={caseMatch}>{CASE_MATCH_LABELS[caseMatch]}</span>
                  {caseMatchReason && <span>{caseMatchReason}</span>}
                </div></div>}
                {!caseVerification && knowledgeCase?.reasoningSummary && <p>{knowledgeCase.reasoningSummary}</p>}
                {!caseVerification && knowledgeCase?.resultSummary && <p>{knowledgeCase.resultSummary}</p>}
              </article>
            ) : (
              <div className="pv-paper">
                <p>{source?.quote || '关联出处已不存在，请重新关联。'}</p>
                {source?.url && /^https?:\/\//iu.test(source.url) &&
                  <a className="source-file-actions" href={source.url} target="_blank" rel="noreferrer">打开来源 ↗</a>}
              </div>
            )}
          </div>}
        </div>
        {!evidence && !isStatute && !caseSource && source?.quote && (
          <div className="ocr">
            <div className="ocr-l">OCR / 原文摘录 · 命中高亮</div>
            <div className="ocr-x">
              {source.quote}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
