import { useRef, useState, type ReactNode } from 'react'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger } from './components/ui/dialog'
import { CASE_REPORT_DISCLAIMER, caseReportOverview, describeCaseReportRow, exportCaseResearchReport, type caseCitations } from './caseResearchReport'
import { api } from '../api'

export function CaseReportButton({ rows, query, children, autoFocus, requireConfirmation }: {
  rows: ReturnType<typeof caseCitations>
  query?: string
  children?: ReactNode
  autoFocus?: boolean
  requireConfirmation?: boolean
}) {
  const app = useApp()
  const exporting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const confirmedPreview = useRef('')
  const disabled = !rows.length || busy || app.busy
  const certificate = app.certificate
  const metadata = { caseName: app.project?.name ?? '', docTitle: certificate?.title, operator: app.workspace?.user.name, query }
  const versionInput = requireConfirmation && certificate ? JSON.stringify([certificate.docKey, certificate.officeFile?.version, certificate.verification,
    certificate.paragraphs.map(item => [item.id, item.text, item.richText])]) : undefined
  const report = requireConfirmation ? {
    type: 'docx-case-report', task: metadata, overview: caseReportOverview(rows), list: rows.map(describeCaseReportRow),
    excerpts: rows.flatMap(row => describeCaseReportRow(row).details), disclaimer: CASE_REPORT_DISCLAIMER,
  } : undefined
  const previewKey = report ? JSON.stringify([app.project?.id, certificate?.id, versionInput, report]) : ''
  const download = async () => {
    if (disabled || exporting.current) return
    exporting.current = true
    setBusy(true)
    try {
      if (report) {
        if (!app.project || confirmedPreview.current !== previewKey) throw new Error('报告内容已变化，请重新预览后确认。')
        const session = sessionStorage.getItem('lawverify-auth-session')
        const bytes = versionInput && new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(versionInput)))
        const version = bytes ? btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '') : undefined
        if (session !== sessionStorage.getItem('lawverify-auth-session')) return
        await api.checkAssistantCaseReport({ caseId: app.project.id, certificateId: certificate?.id, version, report })
        if (session !== sessionStorage.getItem('lawverify-auth-session')) return
      }
      await exportCaseResearchReport(metadata, rows)
      app.toast('已导出案例检索报告')
      await app.auditAssistantAction(certificate?.id, requireConfirmation ? '律师确认并导出助手案例检索报告' : '律师导出案例检索报告')
    } catch (cause) {
      app.setError(cause instanceof Error ? cause.message : '案例报告导出失败。')
    } finally {
      exporting.current = false
      setBusy(false)
      setConfirming(false)
    }
  }
  const button = <Button className="btn btn-gh btn-sm" autoFocus={autoFocus && rows.length > 0} disabled={disabled}
    onClick={requireConfirmation ? undefined : download}>{busy ? '正在生成…' : children ?? '导出案例检索报告'}</Button>
  if (!requireConfirmation) return button
  return <Dialog open={confirming} onOpenChange={open => {
    if (exporting.current) return
    confirmedPreview.current = open ? previewKey : ''
    setConfirming(open)
  }}>
    <DialogTrigger asChild>{button}</DialogTrigger>
    <DialogContent showCloseButton={false}>
      <DialogTitle>确认导出案例报告</DialogTitle>
      <DialogDescription>{caseReportOverview(rows)}{rows.some(row => !row.citations.length) && '补充检索结果仅作待核线索。'}</DialogDescription>
      <DialogFooter>
        <DialogClose asChild><Button variant="outline" disabled={busy}>取消</Button></DialogClose>
        <Button disabled={disabled} onClick={download}>{busy ? '正在生成…' : '确认导出 DOCX'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
