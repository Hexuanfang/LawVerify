import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './components/ui/sheet'
import { EvidenceManagePanel } from '../EvidenceManagePanel'
import { useApp } from './AppContext'
import { fetchWithWorkspaceAccount, getEvidenceSourceUrl } from '../api'

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
  const evidence = app.workspace?.evidences.find(
    (item) => item.id === source?.targetId,
  )
  const law = app.workspace?.knowledgeStatutes.find(
    (item) =>
      item.id === source?.targetId ||
      item.articles.some((article) => article.id === source?.targetId),
  )
  const article = law?.articles.find((item) => item.id === source?.targetId)
  const knowledgeCase = app.workspace?.knowledgeCases.find(
    (item) => item.id === source?.targetId || item.excerpts?.some(excerpt => excerpt.id === source?.targetId),
  )
  const caseVerification = source?.st === 'l3'
    ? app.elements.find(element => element.sources.includes(source))?.caseVerification
    : undefined
  const judgmentUrl = caseVerification?.documents?.find(item => item.id === source?.targetId)?.url
  const url = evidence ? getEvidenceSourceUrl(evidence.id) : ''
  return (
    <Sheet
      open={Boolean(source)}
      onOpenChange={(open) => {
        if (!open) app.setDrawer(null)
      }}
    >
      <SheetContent className="new-drawer" side="right">
        <SheetHeader className="dwh">
          <SheetTitle className="dwt">{source?.name}</SheetTitle>
          <SheetDescription className="dws">
            {source?.st === 'l1'
              ? 'L1 案件原材料'
              : source?.st === 'l2'
                ? 'L2 法条 · 版本信息'
                : caseVerification ? 'L3 案例 · 裁判原文摘录' : 'L3 案例 · 索引与摘要'}{' '}
            · {source?.loc}
          </SheetDescription>
        </SheetHeader>
        <div className="dwb">
          <div className="pv-stage">
            {evidence ? (
              <>
                <div className="source-file-actions">
                  <a href={url} target="_blank" rel="noreferrer">
                    打开原件 ↗
                  </a>
                </div>
                <Suspense fallback={<p>正在加载原件…</p>}>
                  {evidence.type === 'pdf' ? (
                    <PdfPreview sourceUrl={url} name={evidence.name} />
                  ) : evidence.type === 'image' ? (
                    <img
                      className="source-image"
                      src={url}
                      alt={evidence.name}
                    />
                  ) : evidence.type === 'word' &&
                    /\.docx$/i.test(evidence.fileName) ? (
                    <WordPreview url={url} />
                  ) : (
                    <div className="pv-paper">
                      <pre>
                        {evidence.ocrText || '材料正在解析，完成后可查看原文。'}
                      </pre>
                    </div>
                  )}
                </Suspense>
              </>
            ) : law ? (
              <div className="pv-paper statute">
                <div
                  className={
                    law.effectiveStatus === 'effective'
                      ? 'badge-ok'
                      : 'text-fail'
                  }
                >
                  {law.effectiveStatus === 'effective'
                    ? '● 现行有效'
                    : law.effectiveStatus === 'repealed'
                      ? '● 已废止'
                      : '● 已修正'}{' '}
                  ｜ {law.effectiveDate} 施行
                </div>
                <div className="st-t">{law.title}</div>
                <div className="st-n">{[law.issuer, law.version].filter(Boolean).join(' · ')}</div>
                {article ? <>
                  <div className="st-a">{article.articleNumber}</div>
                  <div className="st-x hl">{article.plainText || article.content || source?.quote}</div>
                </> : <div className="st-x">{source?.quote || '可按具体条号检索原文。'}</div>}
                {law.sourceUrl && /^https?:\/\//i.test(law.sourceUrl) &&
                  <a className="source-file-actions" href={law.sourceUrl} target="_blank" rel="noreferrer">打开法规来源 ↗</a>}
              </div>
            ) : caseVerification ? (
              <div className="pv-paper casepv">
                <div className="st-t">{caseVerification.name || source?.name}</div>
                <div className="four">
                  <div><b>案号</b><span>{caseVerification.caseNumber}</span></div>
                  <div><b>审理法院</b><span>{caseVerification.court || '待核对'}</span></div>
                  <div><b>裁判日期</b><span>{caseVerification.judgmentDate || '待核对'}</span></div>
                  <div><b>原文位置</b><span>{source?.loc || '待核对'}</span></div>
                </div>
                <div className="csq">{source?.quote}</div>
                {judgmentUrl?.startsWith('https://') &&
                  <a className="source-file-actions" href={judgmentUrl} target="_blank" rel="noreferrer">打开裁判原文 ↗</a>}
              </div>
            ) : knowledgeCase ? (
              <div className="pv-paper casepv">
                <div className="st-t">{knowledgeCase.title}</div>
                <div className="st-n">民事判决书</div>
                <div className="four">
                  {[
                    ['案号', knowledgeCase.caseNumber],
                    ['审理法院', knowledgeCase.courtName],
                    ['裁判日期', knowledgeCase.judgmentDate],
                    ['效力层级', knowledgeCase.courtLevel],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <b>{label}</b>
                      <span>{value || '未提供'}</span>
                    </div>
                  ))}
                </div>
                <div className="csq">{knowledgeCase.excerpts?.find(item => item.id === source?.targetId)?.content || knowledgeCase.holdingSummary}</div>
                <p>{knowledgeCase.reasoningSummary}</p>
                <p>{knowledgeCase.resultSummary}</p>
              </div>
            ) : (
              <div className="pv-paper">
                <p>{source?.quote || '关联出处已不存在，请重新关联。'}</p>
              </div>
            )}
          </div>
        </div>
        {evidence && <div className="new-material-manage"><EvidenceManagePanel key={evidence.id} evidence={evidence} busy={app.busy}
          onUpdate={patch => app.updateMaterial(evidence.id, patch)} onDelete={() => app.deleteMaterial(evidence.id)} /></div>}
        {(source?.quote || evidence?.ocrText) && (
          <div className="ocr">
            <div className="ocr-l">OCR / 原文摘录 · 命中高亮</div>
            <div className="ocr-x">
              {source?.quote || evidence?.ocrText?.slice(0, 5000)}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
