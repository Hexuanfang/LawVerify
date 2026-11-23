import { useEffect } from 'react'
import { BookOpen, FileCheck, FileText, Sparkles } from 'lucide-react'
import { Button } from './components/ui/button'
import { Brand } from './Home'
import { VERIFICATION_STEPS, verificationRowState } from './verificationProgress'
import { useApp } from './AppContext'
import { STATUS_NAMES, type ReviewElement } from './model'
import { reportSourceLabels as sourceLabels, reviewReportSummary } from './reviewOverview'
import { CaseReportButton } from './CaseReportButton'
import { caseCitations, describeCaseReportRow } from './caseResearchReport'
import { wordExportReadiness } from './workflow'
import { formatVerificationCalculation, VERIFICATION_ACTION_LABELS, verificationImpacts, verificationReportMetadata, verifiedCaseMemory, verifiedDocumentDiagnostics } from './verificationMemory'

export function Report() {
  const app = useApp()
  const cases = caseCitations(app.elements, app.workspace?.knowledgeCases ?? [])
  const diagnostics = app.workspace && app.certificate ? verifiedDocumentDiagnostics(app.workspace, app.certificate) : []
  const calculations = app.workspace && app.certificate ? verifiedCaseMemory(app.workspace, app.certificate.caseId, app.certificate.id)
    .flatMap(item => item.calculation ? [{ item, calculation: item.calculation }] : []) : []
  const completed = app.documentReview.total - app.documentReview.unreviewed
  const stale = Boolean(app.certificate?.linkageStale)
  const impacts = app.certificate ? verificationImpacts(app.certificate, app.elements) : []
  const metadata = app.certificate ? verificationReportMetadata(app.certificate) : undefined
  const allowExport = Boolean(!app.busy && app.workspace && app.certificate && wordExportReadiness(app.workspace, app.certificate.id).allowed)
  const { required, summary, guidance, groups, counts } = reviewReportSummary(app.elements, stale, allowExport, diagnostics.length)
  const jump = (element: ReviewElement) => {
    app.setFilter('all')
    app.select(element.id)
    app.setPage('ws')
  }
  const ask = () => {
    app.setAssistantRequest({ mode: 'case', prompt: `请结合卷内材料归纳《${app.certificate?.title || '当前文书'}》的核验风险与优先处理事项。` })
    app.setPage('ws')
  }
  const audits = app.audits.filter(item => item.certificateId ? item.certificateId === app.docId : item.caseId === app.project?.id)
  const verificationAudits = app.certificate?.verification?.audit ?? []
  return (
    <div className="page active" id="pg-report">
      <div className="topbar">
        <Button className="btn-txt" variant="ghost" onClick={() => app.setPage('ws')}>← 返回工作台</Button>
        <Brand title="核验报告" size={24} />
        <Button className="ml-auto" variant="ghost" size="sm" onClick={ask}><Sparkles size={15} />问 AI</Button>
        {app.certificate?.officeFile && <Button variant="ghost" size="sm" disabled={!allowExport}
          onClick={() => void app.exportWord('original')}>导出原格式</Button>}
      </div>
      <main className="rp-w fade v12-report">
        <div className="rp-hero">
          <h1>{app.certificate?.title || '文书'} · 核验报告</h1>
          <p className="sub">{app.project?.name} ｜ 当前工作区 · LawVerify {__APP_VERSION__}</p>
        </div>
        <section className={`report-conclusion ${required.length ? 'bad' : allowExport ? 'ok' : 'warn'}`} aria-label="核验结论">
          <div><span>核验结论</span><h2>{summary}</h2><p>{guidance}</p></div>
          <span>人工审阅 {completed} / {app.documentReview.total} 段</span>
        </section>
        {metadata && <div className="report-footnote">
          <p>核验规则版本 {metadata.profileVersion}
            {metadata.verifiedAt && <> · 核验时间 <time dateTime={metadata.verifiedAt}>{new Date(metadata.verifiedAt).toLocaleString('zh-CN')}</time></>}
            {metadata.checkedAt > 0 && <> · 最近法源核对 <time dateTime={new Date(metadata.checkedAt).toISOString()}>{new Date(metadata.checkedAt).toLocaleString('zh-CN')}</time></>}
          </p>
          {metadata.statuteVersions.length > 0 && <p>法条版本 {metadata.statuteVersions.join('、')}</p>}
        </div>}
        <div className="report-actions" aria-label="导出文件">
          <section><FileCheck size={19} /><h2>审阅版 Word</h2><p>保留正文和原生 Word 批注。</p>
            <Button className="btn btn-pri btn-sm" disabled={!allowExport} onClick={() => void app.exportWord('review')}>导出审阅版 Word</Button></section>
          <section><FileText size={19} /><h2>清洁版 + 报告</h2><p>清洁正文附核验记录。</p>
            <Button className="btn btn-gh btn-sm" disabled={!allowExport} onClick={() => void app.exportWord('clean')}>清洁版 + 报告</Button></section>
          <section><BookOpen size={19} /><h2>案例检索报告</h2><p>汇编当前文书关联的 L3 案例。</p>
            <CaseReportButton rows={cases} /></section>
        </div>
        <div className="stats report-source-stats" aria-label="信源分类">
          {counts.map(({ source, count }) => (
            <div className="stat" key={source}>
              <b>{count}</b><span>{sourceLabels[source]}</span>
            </div>
          ))}
        </div>
        {groups.map(([title, elements, open]) => (
          <details key={title} className="report-section" open={open}>
            <summary><h2>{title}</h2><span>{elements.length} 项</span></summary>
            {elements.map(element => <div key={element.id}>
              <button type="button" className="iss" onClick={() => jump(element)}>
                <span className={`pill text-${element.verdict}`}>{STATUS_NAMES[element.verdict]}</span>
                <span className="iss-b"><span className="iss-t">{element.quote}</span>
                  <span className="iss-d">{element.reason}</span>
                  {element.ignored && <span className="iss-d">律师已忽略此预警</span>}
                  {element.declaration?.review?.note && <span className="iss-d">声明批注 · {element.declaration.review.note}</span>}
                  {element.original.note && <span className="iss-d">整段批注 · {element.original.note}</span>}</span>
                <span className="iss-go">定位 →</span>
              </button>
              {element.sources.map((source, index) => <Button variant="ghost" size="sm" key={index}
                onClick={() => app.setDrawer(source)}>{[sourceLabels[source.st], source.name, source.loc].filter(Boolean).join(' · ')}</Button>)}
            </div>)}
            {!elements.length && <p className="empty-inline">暂无</p>}
          </details>
        ))}
        {diagnostics.length > 0 && <details className="report-section" open>
          <summary><h2>文书级预警</h2><span>{diagnostics.length} 项</span></summary>
          <ul className="report-case-list">{diagnostics.map(diagnostic => <li key={diagnostic.code}>
            <span className="pill text-warn">{STATUS_NAMES[diagnostic.verdict]}</span>
            <p>{diagnostic.reason}</p>
            {diagnostic.sources.map(source => <Button variant="ghost" size="sm" key={source.id}
              onClick={() => app.setDrawer({ st: 'l1', targetId: source.id, name: source.name, loc: source.locator ?? '', quote: '' })}>
              {source.name} · {source.locator}
            </Button>)}
          </li>)}</ul>
        </details>}
        {calculations.length > 0 && <details className="report-section">
          <summary><h2>金额复算</h2><span>{calculations.length} 项</span></summary>
          <ul className="report-case-list">{calculations.map(({ item, calculation }) => <li key={item.id}>
            <b>第 {item.location.paragraphIndex + 1} 段 · {STATUS_NAMES[item.verdict]}</b>
            <p>{formatVerificationCalculation(calculation)}</p>
            {(calculation.sources ?? item.sources).map((source, index) => <Button variant="ghost" size="sm" key={`${source.id}:${index}`}
              onClick={() => app.setDrawer({ st: 'l1', targetId: source.id, name: source.name, loc: source.locator ?? '', quote: source.quote ?? '' })}>
              {source.name} · {source.locator}
            </Button>)}
          </li>)}</ul>
        </details>}
        <details className="report-section" open={impacts.some(item => item.outcome === 'pending')}>
          <summary><h2>联动影响</h2><span>{stale ? '待重核' : `${impacts.length} 项`}</span></summary>
          {impacts.length ? <ul className="report-case-list">{impacts.map(({ sourceId, source, target, check, reason, outcome }) =>
            <li key={JSON.stringify([sourceId, target.id, check])}>
              <b>{check} · {STATUS_NAMES[outcome]}</b>
              <p>{reason}</p>
              {source ? <Button variant="ghost" size="sm" className="report-location" onClick={() => jump(source)}>依赖声明 · {source.quote}</Button>
                : <p>依赖声明已无法定位</p>}
              <Button variant="ghost" size="sm" className="report-location" onClick={() => jump(target)}>受影响声明 · {target.quote}</Button>
            </li>)}</ul> : <p className="empty-inline">{stale ? '案件材料或文书内容有更新，请回到工作台重新核验。' : '当前文书暂无可定位的依赖检查。'}</p>}
        </details>
        <details className="report-section" open>
          <summary><h2>案例检索报告预览</h2><span>{cases.length} 件</span></summary>
          {cases.length ? <ul className="report-case-list">{cases.map((row, index) => {
            const preview = describeCaseReportRow(row)
            return <li key={index}>
              <b>{preview.title}</b>
              <p>{[preview.caseNumber, preview.court, preview.judgmentDate, preview.source, preview.status].filter(Boolean).join(' · ')}</p>
              {preview.details.map(({ text, url }, detail) => <p key={detail}>
                {url && /^https?:\/\//iu.test(url) ? <a href={url} target="_blank" rel="noreferrer">{text} ↗</a> : text}
              </p>)}
              {row.citations.map(({ source }, citation) => <Button variant="ghost" size="sm" key={citation}
                onClick={() => app.setDrawer(source)}>{source.loc || '查看关联出处'}</Button>)}
            </li>
          })}</ul> : <p className="empty-inline">当前文书暂无关联案例。</p>}
          {cases.length > 0 && <CaseReportButton rows={cases} />}
        </details>
        <details className="report-section">
          <summary><h2>人工操作与核验记录</h2><span>{audits.length + verificationAudits.length} 条</span></summary>
          <div className="report-audits">
            {verificationAudits.map(item => <div key={item.id}>
              <p><time dateTime={item.at}>{new Date(item.at).toLocaleString('zh-CN')}</time> {item.actor} · {VERIFICATION_ACTION_LABELS[item.action]}</p>
              {item.quote && <p>原文 · {item.quote}{item.previousVerdict && ` · ${STATUS_NAMES[item.previousVerdict]}`}</p>}
              {item.note && <p>{item.note}</p>}
              {item.sources?.map((source, index) => <p key={index}>出处 · {source.name} {source.locator}</p>)}
              {!!item.affected?.length && <p>涉及 {item.affected.length} 项声明</p>}
            </div>)}
            {audits.map(item => <p key={item.id}><time dateTime={item.t}>{new Date(item.t).toLocaleString('zh-CN')}</time> {item.account} · {item.msg}</p>)}
            {!audits.length && !verificationAudits.length && '暂无人工操作。'}
          </div>
        </details>
        <p className="report-footnote">核验与检索结果由律师对照原件、现行法条及裁判文书后使用。</p>
      </main>
    </div>
  )
}

export function Processing() {
  const app = useApp()
  const { onProcessingMounted } = app
  useEffect(onProcessingMounted, [onProcessingMounted])
  const stopped = Boolean(app.proc.error)
  const running = !app.proc.done && !stopped
  const draft = app.proc.draft
  const steps = draft ? ['导入并解析案件原材料'] : VERIFICATION_STEPS
  const skippedMaterials = app.proc.skippedMaterials ?? []
  const progress = app.proc.done ? 100 : Math.floor(Math.min(app.proc.step, steps.length - 1) / steps.length * 100)
  const indeterminate = running && progress === 0
  return (
    <div className="page active" id="pg-proc">
      <div className="proc">
        <div className="proc-box fade">
          <div className="proc-t">
            {draft ? stopped ? '材料处理未完成' : '正在准备起草材料' : app.proc.done ? '核验完成' : stopped ? '核验未完成' : '正在核验'}《{app.proc.title || app.certificate?.title || '文书'}》
          </div>
          {!draft && <div className="proc-s">抽取声明 → 定位源头 → 逐项比对 → 绿黄红分档</div>}
          {steps.map((name, index) => {
            const state = verificationRowState(app.proc.step, index, app.proc.done, stopped)
            const label = { done: '已完成', active: '处理中', stopped: '已停止', pending: stopped ? '未执行' : '等待中' }[state]
            return (
              <div className={`pst ${state === 'active' ? 'on' : state}`} key={name}>
                <div className="pst-i">{index + 1}</div>
                <div style={{ fontWeight: 500 }}>{name}</div>
                <div className="proc-meta">{label}</div>
              </div>
            )
          })}
          {skippedMaterials.length > 0 && (
            <section className="proc-skipped" aria-labelledby="proc-skipped-heading">
              <h2 id="proc-skipped-heading">已跳过 {skippedMaterials.length} 份原材料与证据</h2>
              <ul tabIndex={0} aria-labelledby="proc-skipped-heading">
                {skippedMaterials.map(item => (
                  <li key={item.evidenceId}>
                    <strong>{item.fileName}</strong>
                    <div>{item.status === 'failed' ? '解析失败' : '待人工审核'} · {item.reason}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="pbar" role="progressbar" aria-label={draft ? '材料处理进度' : '核验阶段进度'}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
            aria-valuetext={app.proc.done ? '全部阶段已完成' : `${steps[Math.min(app.proc.step, steps.length - 1)]}，${stopped ? '已停止' : '处理中'}`}>
            <i className={indeterminate ? 'indeterminate' : ''} style={{ width: indeterminate ? '36%' : `${progress}%` }} />
          </div>
          <div className="ppct" role="status">{app.proc.error || app.proc.message}</div>
          <div className="proc-actions">
            {app.proc.done ? (
              <Button className="btn btn-pri" disabled={app.busy} onClick={() => app.setPage('ws')}>
                查看核验结果
              </Button>
            ) : stopped ? (
              <>
                <Button className="btn btn-gh" disabled={app.busy} onClick={() => app.setPage(app.caseId ? 'ws' : 'home')}>
                  {app.caseId ? '返回工作台' : '返回案件列表'}
                </Button>
                <Button className="btn btn-pri" disabled={app.busy} onClick={() => void app.retryVerification()}>重试</Button>
              </>
            ) : (
              <Button className="btn btn-gh" onClick={app.cancelVerification}>{draft ? '停止等待' : '取消核验'}</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
