import type { DeclarationSource, VerificationCalculation } from '../../../server/src/intelligence/verification/protocol.ts'
import type { AppState, Certificate } from '../types.ts'
import type { ReviewElement } from './model.ts'

export const VERIFICATION_ACTION_LABELS = {
  confirm: '确认声明', reject: '驳回声明', note: '保存批注', ignore: '忽略预警', 'restore-warning': '恢复预警',
  verify: '核验完成', edit: '正文修改', source: '调整引用', adopt: '采纳已核建议', decline: '拒绝建议', delete: '删除缺源声明',
}

function currentVerification(certificate: Certificate) {
  const result = certificate.verification
  return !certificate.linkageStale && certificate.linkageInputKey && result?.inputKey === certificate.linkageInputKey ? result : undefined
}

export function verificationImpacts(certificate: Certificate, elements: ReviewElement[]) {
  const saved = certificate.verification
  const result = saved?.dirty && saved.inputKey === certificate.linkageInputKey ? saved : currentVerification(certificate)
  if (!result) return []
  const paragraphs = new Map(certificate.paragraphs.map(item => [item.id, item.text]))
  const byId = new Map(elements.filter(item => item.certificateId === certificate.id).map(item => [item.id, item]))
  const anchored = new Map(result.declarations.flatMap(declaration => {
    const { paragraphId, start, end } = declaration.location
    const element = byId.get(declaration.id)
    return element?.paragraphId === paragraphId && element.start === start && element.end === end
      && element.quote === declaration.quote && paragraphs.get(paragraphId)?.slice(start, end) === declaration.quote
      ? [[declaration.id, element] as const] : []
  }))
  return result.declarations.flatMap(declaration => {
    const target = anchored.get(declaration.id)
    if (!target) return []
    return (declaration.dependencies ?? []).flatMap(({ id, check }) => {
      const finding = declaration.checks[check]
      if (!finding || finding.outcome === 'not-applicable') return []
      const pending = result.dirty?.declarationIds.includes(declaration.id) && finding.outcome !== 'fail' && finding.outcome !== 'miss'
      return [{ sourceId: id, source: anchored.get(id), target, check, outcome: pending ? 'pending' as const : finding.outcome,
        reason: pending ? '依赖已变化，等待局部重核。' : finding.reason }]
    })
  })
}

export function verificationReportMetadata(certificate: Certificate) {
  const result = currentVerification(certificate)
  if (!result) return undefined
  const checkedAt = result.declarations.flatMap(item => [item.statuteVerification?.checkedAt, item.caseVerification?.checkedAt])
    .reduce((latest, value) => Math.max(latest, value ? Date.parse(value) || 0 : 0), 0)
  const statuteVersions = [...new Set(result.declarations.flatMap(item => item.sources.flatMap(source =>
    source.tier === 'l2' && source.version ? [`${source.name} ${source.version}`] : [])))]
  return { profileVersion: result.profileVersion, checkedAt, statuteVersions, verifiedAt: result.verifiedAt }
}

function currentL1Source(workspace: AppState, caseId: string) {
  const materials = new Map(workspace.evidences.filter(item => item.caseId === caseId && (!item.parsing || item.parsing.status === 'ready')).map(item => [item.id, item]))
  return (source: DeclarationSource) => {
    const material = materials.get(source.id)
    return source.tier === 'l1' && Boolean(material && source.locator?.trim()
      && source.version === (material.contentHash ?? material.sourceFingerprint))
  }
}

export function verifiedDocumentDiagnostics(workspace: AppState, certificate: Certificate) {
  const diagnostics = currentVerification(certificate)?.documentDiagnostics
  if (!diagnostics?.length) return []
  const isCurrent = currentL1Source(workspace, certificate.caseId)
  return diagnostics.flatMap(diagnostic => {
    const sources = diagnostic.sources.filter(isCurrent)
    return sources.length ? [{ ...diagnostic, sources }] : []
  })
}

export function formatVerificationCalculation(calculation: VerificationCalculation) {
  if (calculation.kind === 'trade-balance') {
    return `货款总额 ${calculation.total} 元 − 累计实付 ${calculation.paid} 元 = 欠款 ${calculation.amount.toFixed(2)} 元`
  }
  const rate = Number((calculation.rate * 100).toPrecision(12))
  return `单利 ${calculation.principal} 元 × ${rate}% × ${calculation.days} 天 ÷ ${calculation.annualDays} 天 = ${calculation.amount.toFixed(2)} 元`
}

export function verifiedCaseMemory(workspace: AppState, caseId: string, certificateId?: string) {
  const isCurrent = currentL1Source(workspace, caseId)
  return workspace.certificates.filter(item => item.caseId === caseId && (!certificateId || item.id === certificateId)).flatMap(certificate => {
    const result = currentVerification(certificate)
    if (!result) return []
    const paragraphs = new Map(certificate.paragraphs.map(item => [item.id, item.text]))
    return result.declarations.flatMap(declaration => {
      const { paragraphId, start, end } = declaration.location
      const sources = declaration.sources.filter(source => source.quote?.trim() && isCurrent(source))
      if (!sources.length || paragraphs.get(paragraphId)?.slice(start, end) !== declaration.quote) return []
      const basis = declaration.calculation?.sources
      const calculation = !basis || (basis.length && basis.every(item => sources.some(source =>
        source.id === item.id && source.version === item.version && source.locator === item.locator && source.quote === item.quote)))
        ? declaration.calculation : undefined
      return [{ ...declaration, sources, calculation, certificateId: certificate.id, certificateTitle: certificate.title }]
    })
  })
}
