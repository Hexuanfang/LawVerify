import { useApp } from './AppContext'
import { CaseReportButton } from './CaseReportButton'
import { CASE_REPORT_DISCLAIMER, caseCitations, caseReportOverview, describeCaseReportRow, type CaseReportSupplement } from './caseResearchReport'

export function AssistantCaseReport({ supplements }: { supplements: CaseReportSupplement[] }) {
  const app = useApp()
  const rows = caseCitations(app.elements, app.workspace?.knowledgeCases ?? [], supplements)

  return <section className="workspace-ai-lookup assistant-case-report" aria-label="案例报告预览">
    <p>{rows.length ? caseReportOverview(rows) : '当前文书暂无已关联案例。'}</p>
    {rows.map((row, index) => {
      const item = describeCaseReportRow(row)
      return <article key={index} className="workspace-ai-result">
        <h3>{item.title}</h3>
        <p>{[item.caseNumber || '案号未记录', item.court || '法院未记录', item.judgmentDate || '裁判日期未记录'].join(' · ')}</p>
        <p>{item.source} · {item.status}</p>
        {item.details.map(({ text, url }, detailIndex) => <p key={detailIndex}>
          {text}{url && '　'}{url && (/^https?:\/\//i.test(url) ? <a href={url} target="_blank" rel="noreferrer">{url}</a> : url)}
        </p>)}
      </article>
    })}
    {!!rows.length && <p>{CASE_REPORT_DISCLAIMER}</p>}
    <CaseReportButton rows={rows} autoFocus requireConfirmation />
  </section>
}
