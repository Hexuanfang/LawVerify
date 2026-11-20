import type { KnowledgeCase } from '../domain.js'
import { isOfficialCaseUrl, normalizeCaseNumber, rankCases } from '../intelligence/legal-verification.js'
import { createLegalCaseAdapter } from './legal-case.js'

type ReadDetail = (url: string, number: string, signal?: AbortSignal) => Promise<{ outcome: string; item?: object }>

export function createWorkspaceCaseAdapter(cases: KnowledgeCase[], readDetail?: ReadDetail) {
  return createLegalCaseAdapter(readDetail ? 'official-case-page' : 'workspace-case-index', async (request, signal) => {
    if (request.action === 'semantic' || request.action === 'keyword') {
      const candidates = request.action === 'semantic' ? rankCases(cases, { keyword: request.query }).slice(0, request.top_k ?? 10)
        : cases.filter(item => normalizeCaseNumber(item.caseNumber) === normalizeCaseNumber(request.case_number))
      return { items: candidates.map(item => ({ id: item.id, case_number: item.caseNumber, url: item.sourceUrl })) }
    }
    const candidates = 'id' in request ? cases.filter(item => item.id === request.id)
      : cases.filter(item => normalizeCaseNumber(item.caseNumber) === normalizeCaseNumber(request.case_number))
    const source = candidates.find(item => isOfficialCaseUrl(item.sourceUrl))
    if (!source?.sourceUrl || !readDetail) return { outcome: source || candidates.length ? 'unverified-detail' : 'not-queried' }
    const answer = await readDetail(source.sourceUrl, source.caseNumber, signal)
    return answer.outcome === 'found' && answer.item ? { items: [{ ...answer.item, id: source.id, url: source.sourceUrl }] } : { outcome: answer.outcome }
  })
}
