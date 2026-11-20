import { createLegalStatuteAdapter } from '../../src/integrations/legal-statute.ts'
import { extractDeclarations } from '../../src/intelligence/verification/extract.ts'
import { verifyEvidenceDeclarations } from '../../src/intelligence/verification/evidence.ts'
import { statuteQuoteMatches, verifyLegalDeclarations } from '../../src/intelligence/verification/legal.ts'
import { quotedStatuteText } from '../../src/intelligence/verification/review-status.ts'

const fixtureDate = '2023-03-15'
const toolFailures = new Set(['TOOL-EMPTY', 'TOOL-NO-HITS', 'TOOL-403'])
const lawCases = new Set(['ADV-02', 'ADV-03', 'ADV-04', 'ADV-10', 'STATUTE-HISTORICAL', 'STATUTE-REPLACEMENT-ONLY',
  'STATUTE-QUOTE-FORMATTING', 'STATUTE-QUOTE-PERIOD', 'SOURCE-NO-URL', ...toolFailures])
const lawName = value => value?.replace(/^中华人民共和国/u, '')

function fixedProvider(details) {
  return async request => ({ items: request.action !== 'article_detail' ? details
    : details.filter(item => request.id ? item.id === request.id : lawName(item.law_name) === lawName(request.law_name)
      && item.article_number === request.article_number) })
}

async function verifyLaw(id, docKey, text, transport, contractFact) {
  const localSource = contractFact && { id: 'fixture-contract', caseId: id, name: '受控借款合同及履行记录',
    fileName: '受控借款合同及履行记录.txt', type: 'text', ocrText: contractFact, anchorHint: '第 1 段' }
  const links = localSource ? [{ evidenceId: localSource.id, locator: localSource.anchorHint, quote: contractFact,
    sentenceIndex: 0, sentenceText: contractFact, relation: 'support' }] : []
  const paragraphs = localSource ? [{ id: 'contract', text: contractFact, links, verified: true }, { id: 'original', text }]
    : [{ id: 'original', text }]
  const certificate = { id, caseId: id, docKey, paragraphs }
  const { declarations } = extractDeclarations(certificate)
  const evidenceChecked = localSource ? verifyEvidenceDeclarations(certificate, declarations, {
    evidences: [localSource], evidenceFragments: [{ evidenceId: localSource.id, locator: localSource.anchorHint, text: contractFact }], evidenceInsights: [],
  }) : declarations
  const checked = await verifyLegalDeclarations(certificate, evidenceChecked, { knowledgeStatutes: [], knowledgeCases: [] },
    createLegalStatuteAdapter(transport))
  return checked.find(item => item.type === 'E-LAW')
}

function observe(law, expectedArticle, text) {
  const sources = law?.sources ?? []
  const documentQuote = law && quotedStatuteText(text.slice(law.location.end))?.[1]
  const sourceQuote = sources.find(source => source.id === expectedArticle)?.quote
  const quoteEvidence = documentQuote !== undefined && sourceQuote ? { document: documentQuote, source: sourceQuote } : null
  const allowCitation = !!law && ['pass', 'warn', 'note'].includes(law.verdict) && sources.length > 0
  return { type: law?.type, verdict: law?.verdict, sourceTier: sources[0]?.tier ?? 'l0', allowCitation,
    retraceable: sources.some(item => !!item.url), verifiedText: law?.verifiedText ?? null,
    substitutedSource: sources.some(item => item.id !== expectedArticle),
    validity: law?.statuteVerification?.validity,
    historicallyApplicable: law?.statuteVerification?.applicability === 'applicable',
    quoteEvidence,
    redlineHitWhenBlocked: allowCitation && !!quoteEvidence && !statuteQuoteMatches(quoteEvidence.document, quoteEvidence.source),
    suggestionOnly: !law?.verifiedText && !!law?.checks.B2?.reason.includes('替代条文待核'),
    checks: law?.checks ?? {}, sources,
  }
}

export async function scoreStatuteControlled(item, fixtures) {
  if (!lawCases.has(item.id)) return undefined
  const { id, input, expected } = item
  const fixture = { ...fixtures.definition, id: 't4-controlled-675', law_name: '测试专用法规', article_number: '第675条', text: input.provider?.text }
  let quote = input.quote ?? input.modelCandidate ?? '依据《测试专用法规》第675条。'
  let expectedArticle = fixture.id
  let transport = async request => request.action === 'article_detail'
    ? { outcome: input.provider?.outcome } : { items: [] }
  let contractFact
  if (id === 'STATUTE-HISTORICAL') {
    const detail = fixtures.old
    contractFact = `${input.factDate}签订借款合同且到期未履行还款义务。`
    quote = `依据《${detail.law_name}》${detail.article_number}：“${detail.text}”`
    transport = fixedProvider([detail])
    expectedArticle = detail.id
  } else if (id === 'ADV-03' || id === 'STATUTE-REPLACEMENT-ONLY') {
    const date = input.factDate ?? fixtureDate
    contractFact = `${date}签订借款合同且到期未履行还款义务。`
    quote = `请求判令被告承担违约责任。依据《${fixtures.old.law_name}》${fixtures.old.article_number}：“${fixtures.old.text}”`
    const replacement = id === 'ADV-03' ? fixtures.replacement : { ...fixtures.replacement, text: undefined }
    transport = fixedProvider([fixtures.old, replacement])
    expectedArticle = fixtures.old.id
  } else if (input.provider?.outcome === 'found') {
    transport = fixedProvider([id === 'SOURCE-NO-URL' ? { ...fixture, text: fixtures.definition.text, url: undefined } : fixture])
  } else if (id === 'TOOL-EMPTY' || id === 'TOOL-NO-HITS') {
    transport = async () => id === 'TOOL-EMPTY' ? null : { items: [] }
  }
  const law = await verifyLaw(id, input.docKey ?? 'qs', quote, transport, contractFact)
  const actual = observe(law, expectedArticle, quote)
  const pass = Object.entries(expected).every(([key, value]) => {
    if (key === 'failedCheck') return actual.checks[value]?.outcome === 'fail'
    if (key === 'passedCheck') return actual.checks[value]?.outcome === 'pass'
    if (key === 'suggestionContains') return actual.verifiedText?.includes(value)
    return actual[key] === value
  })
  return { id, status: pass ? 'pass' : 'fail', expected, actual }
}

export function scoreStatuteQuoteMutation(item, baseline) {
  const evidence = baseline?.actual?.quoteEvidence
  if (!evidence) return { id: item.id, status: 'not-run', reason: '缺少可对照的引文和同版本详情原文。' }
  const released = baseline.actual.allowCitation || item.input.actualOutputAcceptsQuoteAsOriginal === true
    || item.input.actualOutputExportsQuoteAsVerified === true
  const redlineHit = released && !statuteQuoteMatches(evidence.document, evidence.source)
  return { id: item.id, status: redlineHit === item.expected.redlineHit ? 'pass' : 'fail', actual: { redlineHit } }
}

export async function scoreSeedStatutes(documents, fixtures) {
  const scenarios = [
    { id: 'c1-l2', documentId: 'c1-dlc', detail: fixtures.definition, expected: ['pass', 'warn', 'miss'] },
    { id: 'c1-l4', documentId: 'c1-dlc', detail: fixtures.old, factDate: fixtureDate, expected: ['pass', 'fail', 'miss'] },
    { id: 'c1-s4', documentId: 'c1-ss', detail: fixtures.appeal, expected: ['pass', 'warn', 'miss'] },
  ]
  return Promise.all(scenarios.map(async ({ id, documentId, detail, factDate, expected }) => {
    const source = documents.find(item => item.id === documentId)
    const quote = source?.paragraphs.find(paragraph => paragraph.includes(detail.article_number))
    if (!quote) return { id, status: 'not-run' }
    const text = factDate ? `${factDate}交付借款。${quote}` : quote
    const law = await verifyLaw(id, source.docKey, text, fixedProvider([detail, fixtures.replacement]))
    const codes = ['B1', 'B2', 'B3']
    const actual = Object.fromEntries(codes.map(code => [code, law?.checks[code]?.outcome ?? null]))
    const matched = codes.every((code, index) => actual[code] === expected[index])
    return { id, status: matched ? 'partial' : 'fail', actual, scope: factDate ? '原型原句、受控事实日和详情' : '原型原句与受控详情' }
  }))
}
