import type { Certificate, Evidence, EvidenceLink, WorkspaceState } from '../../domain.js'
import { getLinkageSentences, resolveExactLinkageSentence } from '../linkage-policy.js'
import type { CheckOutcome, Declaration, DeclarationSource, DocumentDiagnostic } from './protocol.js'

const compact = (value: string) => value.normalize('NFKC').replace(/[\s，,。；;：:“”"‘’]/gu, '')
function textBound(text: string | undefined, quote: string) {
  const needle = compact(quote)
  if (!text || !needle) return false
  const source = compact(text)
  const startsWithDigit = /^\d/u.test(needle)
  const endsWithDigit = /\d$/u.test(needle)
  for (let start = source.indexOf(needle); start >= 0; start = source.indexOf(needle, start + 1)) {
    const end = start + needle.length
    const clippedStart = startsWithDigit && /(?:\d\.?|[+−-])$/u.test(source.slice(Math.max(0, start - 2), start))
    const clippedEnd = endsWithDigit && /^\.?\d/u.test(source.slice(end, end + 2))
    if (!clippedStart && !clippedEnd) return true
  }
  return false
}
const evidenceName = (value: string) => compact(value.replace(/^(?:证据(?:名称)?\s*[\d一二三四五六七八九十]*\s*[:：]|(?:第\s*)?[\d一二三四五六七八九十]+\s*[项、.．)）]\s*[:：]?)/u, '').replace(/[\s|｜]+$/gu, '')).replace(/\.[a-z0-9]{1,5}$/iu, '')
const datePattern = /(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?/u
const amountPattern = /(\d[\d,，]*(?:\.\d+)?)\s*(万)?元/u
const party = /^(原告|被告|答辩人|上诉人|被上诉人)(?=于|在|自|已|实际|向|未|支付|偿还|转账|付款)/u
const laterPayment = /^(原告|被告|答辩人|上诉人|被上诉人)(?:已)?(?:于|在)(\d{4}年\d{1,2}月\d{1,2}日)(?:已|实际)?(?:向([^。；，\n]{1,20}?))?(?:支付|偿还|转账|付款)(.*)$/u
const noLaterPayment = /^(原告|被告|答辩人|上诉人|被上诉人)(?:自|于)(\d{4}年\d{1,2}月\d{1,2}日)(?:起|之后|以后|后)?\s*(?:未再|再未)(?:向([^。；，\n]{1,20}?))?(?:支付|付款|付)(.*)$/u
const noPaymentAfter = /[，,]\s*(?:此后|其后)(?:未再|再未)(?:向([^。；，\n]{1,20}?))?(?:支付|付款|付)(.*)$/u
const recipientAfterPayment = /(?:给|转入)([^\d\s。；，、]{1,20})(?:[。；，、]|$)/u
const paymentKind = /本金|利息|违约金|货款/u
const installment = /第\s*([\d一二三四五六七八九十]+)\s*期/u
const statementMonth = /(\d{4})\s*年\s*(\d{1,2})\s*月(?=\s*(?:流水|账期|期))/u
const priorLocator = /本院(?:认为|查明)|判项|裁判主文|第\s*\d+\s*(?:页|段)/u
const priorMaterial = /(?:一审|二审|原审|前审)[^\n]{0,12}(?:判决|裁定)|(?:民事|刑事|行政)判决书|裁判文书/u
const value = (item: string) => Number(item.replace(/[,，]/gu, ''))
const dateValue = (text: string) => {
  const match = text.match(datePattern)
  return match ? Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]) : undefined
}
type EvidenceWorkspace = Pick<WorkspaceState, 'evidences' | 'evidenceFragments' | 'evidenceInsights'>
type EvidenceSource = { source: DeclarationSource; material: Evidence; relation?: EvidenceLink['relation'] }

const sourceFor = (material: Evidence, quote?: string, locator?: string): DeclarationSource => ({
  tier: 'l1', id: material.id, name: material.name || material.fileName, locator,
  quote, version: material.contentHash ?? material.sourceFingerprint,
})

function compare(candidate: string, receipt: string) {
  const differences: NonNullable<Declaration['differences']> = []
  const fields: string[] = []
  let incomplete = false
  const field = (name: string, doc: RegExpMatchArray | null, source: RegExpMatchArray | null, normalize: (match: RegExpMatchArray) => string | number) => {
    if (!doc) return
    if (!source) {
      incomplete = true
      fields.push(`${name}待核实`)
    } else if (normalize(doc) !== normalize(source)) {
      differences.push({ field: name, document: doc[0], source: source[0] })
      fields.push(`${name}不一致`)
    } else fields.push(`${name}一致`)
  }
  field('日期', candidate.match(datePattern), receipt.match(datePattern), match => dateValue(match[0]) ?? '')
  field('金额', candidate.match(amountPattern), receipt.match(amountPattern), match => value(match[1]) * (match[2] ? 10_000 : 1))
  field('主体', candidate.match(party), receipt.match(party), match => match[0])
  field('性质', candidate.match(paymentKind), receipt.match(paymentKind), match => match[0])
  return { differences, incomplete, summary: fields.join('、') }
}

function differentField(left: string, right: string, pattern: RegExp) {
  const first = left.match(pattern)?.[1]
  const second = right.match(pattern)?.[1]
  return Boolean(first && second && first !== second)
}

function differentPaymentPeriod(left: string, right: string) {
  const normalize = (text: string) => {
    const value = text.match(installment)?.[1]
    if (!value || /^\d+$/u.test(value)) return value && Number(value)
    const digits = '零一二三四五六七八九'
    if (value.length === 1 && value !== '十') return digits.indexOf(value)
    const match = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(value)
    return match ? (match[1] ? digits.indexOf(match[1]) : 1) * 10 + (match[2] ? digits.indexOf(match[2]) : 0) : value
  }
  const leftInstallment = normalize(left)
  const rightInstallment = normalize(right)
  if (leftInstallment && rightInstallment && leftInstallment !== rightInstallment) return true
  const first = left.match(statementMonth)
  const second = right.match(statementMonth)
  return Boolean(first && second && (first[1] !== second[1] || Number(first[2]) !== Number(second[2])))
}

function assertedPayment(text: string) {
  const match = laterPayment.exec(text)
  return match && !/的(?:义务|责任|期限|条件|约定|计划|安排|请求)|后(?:方可|才(?:能|可)|即可)/u.test(match[4]) ? match : undefined
}

function paymentDenial(text: string) {
  const straight = noLaterPayment.exec(text)
  if (straight) return { payer: straight[1], date: dateValue(straight[2]), scope: straight[4],
    recipient: straight[3] ?? straight[4].match(recipientAfterPayment)?.[1] }
  const payment = assertedPayment(text)
  const after = payment && noPaymentAfter.exec(payment[4])
  return payment && after ? { payer: payment[1], date: dateValue(payment[2]), scope: after[2],
    recipient: after[1] ?? after[2].match(recipientAfterPayment)?.[1] } : undefined
}

function observedPayment(text: string) {
  const match = assertedPayment(text)
  return match ? { payer: match[1], date: dateValue(match[2]) ?? 0, scope: match[4],
    recipient: match[3] ?? match[4].match(recipientAfterPayment)?.[1] } : undefined
}

function isLaterPayment(denial: NonNullable<ReturnType<typeof paymentDenial>>, payment: NonNullable<ReturnType<typeof observedPayment>>) {
  return payment.payer === denial.payer && payment.date > (denial.date ?? Infinity)
    && (!denial.recipient || denial.recipient === payment.recipient)
    && !differentPaymentPeriod(denial.scope, payment.scope) && !differentField(denial.scope, payment.scope, /(本金|利息|违约金|货款)/u)
}

function reversal(document: string, source: string): Declaration['differences'] {
  const unpaid = /(?:分文未付|从未支付|没有支付)/u
  const paid = /(?:已支付|支付(?:本金|利息|货款)?\s*\d)/u
  if ((unpaid.test(document) && paid.test(source)) || (paid.test(document) && unpaid.test(source))) {
    return [{ field: '前审付款认定', document, source }]
  }
  const dismissed = /驳回/u
  const granted = /支持|(?:判令|被告向原告).*(?:赔偿|支付|偿还)/u
  if ((dismissed.test(document) && granted.test(source) && !dismissed.test(source))
    || (granted.test(document) && !dismissed.test(document) && dismissed.test(source))) {
    return [{ field: '前审判项', document, source }]
  }
  const liability = /(连带|补充)(?:赔偿)?责任/u
  const stated = document.match(liability)?.[1]
  const actual = source.match(liability)?.[1]
  if (stated && actual && stated !== actual) return [{ field: '责任性质', document: stated, source: actual }]
  return undefined
}

function purposeCheck(declaration: Declaration, linked: EvidenceSource[]): { outcome: CheckOutcome; reason: string } {
  const purpose = declaration.quote.replace(/^(?:拟证明|证明)\s*[：:]?\s*/u, '')
  const originals = linked.map(item => item.source.quote || item.material.ocrText).filter(text => text?.trim())
  if (!originals.length) return { outcome: 'miss', reason: '缺少对应证据的可回查内容。' }
  const claim = compact(purpose)
  const affirmed = (text: string) => Boolean(claim && getLinkageSentences(text).some(({ sentenceText }) => {
    const sentence = compact(sentenceText)
    const start = sentence.indexOf(claim)
    return start >= 0 && !/(?:不能|无法|未能|不足以)(?:证明|认定|确认)|否认|是否|并非|有待(?:证明|确认)/u.test(sentence.slice(0, start))
  }))
  const excerpt = originals[0].trim().slice(0, 160)
  const strongClaim = /(?:构成|实施).{0,6}(?:欺诈|诈骗|犯罪)|恶意/u.test(purpose)
  if (strongClaim && linked.some(item => priorMaterial.test(item.material.name || item.material.fileName) && item.source.quote && affirmed(item.source.quote))) {
    return { outcome: 'pass', reason: '已定位的裁判原文支持所列证明目的。' }
  }
  if (strongClaim) return { outcome: 'fail', reason: `证明目的超出材料所载事实。材料原文「${excerpt}」。` }
  if (originals.some(affirmed)) return { outcome: 'pass', reason: '证据原文支持所列证明目的。' }
  return { outcome: 'warn', reason: `请将证明目的收窄至材料所载事实。材料原文「${excerpt}」。` }
}

const interestFormula = /(\d[\d,，]*(?:\.\d+)?)\s*(万)?元\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*[%％]\s*[×xX*]\s*(\d+)\s*天\s*[÷/]\s*(360|365|366)(?!\d)/u
const declaredInterest = /^(?:\s|[，,])*(?:计算[，,\s]*)?(?:[=＝]|合计|共计|等于|计为)\s*(\d[\d,，]*(?:\.\d+)?)\s*(万)?元/u
const claimedDebt = /(?:尚欠|剩余货款)\s*(\d[\d,，]*(?:\.\d+)?)\s*(万)?元/u
const statedTradePayment = /(?:已支付|仅支付|实付)\s*(?:货款)?\s*(\d[\d,，]*(?:\.\d+)?)\s*(万)?元/u
const confirmedTradePayment = /(?:累计已付(?:货款)?|累计支付(?:货款)?|实付总额|已付货款合计)\s*[：:]?\s*(\d[\d,，]*(?:\.\d+)?)\s*(万)?元/u
const totalTradeValue = /(?:货款总额|货款合计|货款共计|货款总价)\s*[：:]?\s*(\d[\d,，]*(?:\.\d+)?)\s*(万)?元/u

function moneyInCents(amount: RegExpMatchArray) {
  return Math.round(value(amount[1]) * (amount[2] ? 1_000_000 : 100))
}

function tradeBalance(sources: EvidenceSource[]) {
  const balances = sources.flatMap(item => {
    if (item.relation !== 'support' || !item.source.quote) return []
    const total = item.source.quote.match(totalTradeValue)
    const paid = item.source.quote.match(confirmedTradePayment)
    if (!total || !paid) return []
    const totalCents = moneyInCents(total)
    const paidCents = moneyInCents(paid)
    return Number.isSafeInteger(totalCents) && Number.isSafeInteger(paidCents) && paidCents <= totalCents
      ? [{ total: totalCents, paid: paidCents, amount: totalCents - paidCents, source: item.source }] : []
  })
  const first = balances[0]
  return first && balances.every(item => item.total === first.total && item.paid === first.paid)
    ? { ...first, sources: balances.map(item => item.source) } : undefined
}

function oppositionCatalog(materials: Evidence[], roleFor: (id: string) => string | undefined) {
  const catalogs = materials.filter(item => !item.duplicateOf && /对方证据(?:目录|清单)/u.test(item.name || item.fileName)
    && roleFor(item.id) === 'party_statement')
  if (catalogs.length !== 1) return undefined
  const content = catalogs[0].ocrText?.trim() ?? ''
  const total = content.match(/共\s*(\d+)\s*项/u)?.[1]
  const entries = [...content.matchAll(/^\s*证据\s*(\d+)\s*[：:、]\s*(\S[^\r\n]*)$/gmu)]
  const numbers = new Set(entries.map(entry => Number(entry[1])))
  return numbers.size > 0 && entries.length === numbers.size && numbers.size === Number(total)
    ? { numbers, names: new Set(entries.map(entry => evidenceName(entry[2]))) } : undefined
}

function localCalculation(formula: RegExpMatchArray, sources: EvidenceSource[]) {
  const supporting = sources.filter(item => item.relation === 'support' && textBound(item.source.quote, formula[0]))
  if (!supporting.length) return undefined
  const principal = value(formula[1]) * (formula[2] ? 10_000 : 1)
  const rate = Number(formula[3]) / 100
  const days = Number(formula[4])
  const annualDays = Number(formula[5])
  const amountCents = principal * rate * days * 100 / annualDays
  if (!(principal > 0) || !Number.isSafeInteger(days) || days <= 0 || !Number.isSafeInteger(Math.round(amountCents))) return undefined
  return { kind: 'simple-interest' as const, principal, rate, days, annualDays, amount: Math.round(amountCents) / 100,
    sources: supporting.map(item => item.source) }
}

export function verifyEvidenceDeclarations(certificate: Pick<Certificate, 'caseId' | 'docKey' | 'paragraphs'>, declarations: Declaration[], workspace: EvidenceWorkspace): Declaration[] {
  return verifyEvidence(certificate, declarations, workspace).declarations
}

export function verifyEvidence(certificate: Pick<Certificate, 'caseId' | 'docKey' | 'paragraphs' | 'verification'>, declarations: Declaration[], workspace: EvidenceWorkspace,
  targets?: ReadonlySet<string>): {
  declarations: Declaration[]; documentDiagnostics: DocumentDiagnostic[]
} {
  const materials = workspace.evidences.filter(item => item.caseId === certificate.caseId && item.type !== 'other' && (!item.parsing || item.parsing.status === 'ready'))
  const eligible = new Map(materials.map(item => [item.id, item]))
  const paragraphs = new Map(certificate.paragraphs.map(item => [item.id, item]))
  const evidenceRows = declarations.filter(item => item.type === 'E-EVID')
  const insights = new Map<string, EvidenceWorkspace['evidenceInsights'][number]>()
  for (const insight of workspace.evidenceInsights) {
    if (!eligible.has(insight.evidenceId)) continue
    const current = insights.get(insight.evidenceId)
    if (!current || insight.version >= current.version) insights.set(insight.evidenceId, insight)
  }
  const fragmentsByMaterial = new Map<string, EvidenceWorkspace['evidenceFragments']>()
  for (const fragment of workspace.evidenceFragments) {
    if (!eligible.has(fragment.evidenceId)) continue
    const fragments = fragmentsByMaterial.get(fragment.evidenceId)
    if (fragments) fragments.push(fragment)
    else fragmentsByMaterial.set(fragment.evidenceId, [fragment])
  }
  const nameMatches = (quote: string) => {
    const name = evidenceName(quote)
    const matches = materials.filter(item => [item.name, item.fileName].some(label => evidenceName(label) === name))
    const canonical = matches.map(item => (item.duplicateOf && eligible.get(item.duplicateOf)) || item)
    return [...new Map(canonical.filter(item => insights.get(item.id)?.materialRole !== 'working_draft').map(item => [item.id, item])).values()]
  }
  const opposing = certificate.docKey === 'zz' ? oppositionCatalog(materials, id => {
    const insight = insights.get(id)
    return insight?.status === 'ready' ? insight.materialRole : undefined
  }) : undefined
  const ownCatalog = certificate.docKey === 'zj' ? new Map(evidenceRows.map(row => [row.id, nameMatches(row.quote)])) : undefined
  const listed = new Set([...(ownCatalog?.values() ?? [])].flatMap(matched => matched.length === 1 ? [matched[0].id] : []))
  const omitted = ownCatalog ? materials.filter(item => {
    const insight = insights.get(item.id)
    return !item.duplicateOf && !listed.has(item.id) && insight?.status === 'ready'
      && (insight.materialRole === 'source_evidence' || insight.materialRole === 'identity')
  }) : []
  const documentDiagnostics: DocumentDiagnostic[] = omitted.length ? [{
    code: 'A3', verdict: 'warn', reason: '卷内材料未列入证据清单，请复核是否应补列。',
    sources: omitted.map(item => sourceFor(item, undefined, fragmentsByMaterial.get(item.id)?.find(fragment => fragment.locator.trim())?.locator
      ?? (item.anchorHint?.trim() || '材料全文'))),
  }] : []
  const payments = certificate.paragraphs.flatMap((item, paragraphIndex) => getLinkageSentences(item.text).flatMap(({ sentenceText, sentenceIndex }) => {
    const payment = observedPayment(sentenceText)
    return payment ? [{ ...payment, paragraphIndex, sentenceIndex }] : []
  }))

  const verified = declarations.map(declaration => {
    if (targets && !targets.has(declaration.id)) return declaration
    if (!['E-SUBJ', 'E-FACT', 'E-CALC', 'E-EVID', 'E-PURP', 'E-CROSS', 'E-ERR'].includes(declaration.type)) return declaration
    const paragraph = paragraphs.get(declaration.location.paragraphId)
    if (!paragraph) return declaration
    const type = declaration.type
    const catalogEntry = certificate.docKey === 'zj' && type === 'E-EVID'
    const purposeRow = type === 'E-PURP' ? evidenceRows.find(item => item.location.row === declaration.location.row
      && (item.location.paragraphId === declaration.location.paragraphId
        || (declaration.location.column !== undefined && item.location.paragraphIndex === declaration.location.paragraphIndex - 1))) : undefined
    const row = catalogEntry ? declaration : purposeRow
    const named = row ? ownCatalog?.get(row.id) ?? nameMatches(row.quote) : []
    const catalogBound = certificate.docKey === 'zj' && (catalogEntry || type === 'E-PURP')
    const links = paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []
    const sentences = getLinkageSentences(paragraph.text)
    const linked = links.flatMap((link): EvidenceSource[] => {
      const target = link.id && certificate.verification?.manualReferences?.[link.id]
      if (target && target !== declaration.id) return []
      if (link.sentenceIndex !== undefined || link.sentenceText?.trim()) {
        const anchor = resolveExactLinkageSentence(paragraph.text, link)
        if (!anchor || declaration.location.sentenceIndex !== anchor.sentenceIndex) return []
      } else if (sentences.length > 1) {
        const matches = sentences.filter(item => textBound(link.quote, item.sentenceText))
        if (matches.length !== 1 || matches[0].sentenceIndex !== declaration.location.sentenceIndex) return []
      }
      if (!link.locator?.trim() || !link.quote?.trim()) return []
      const material = eligible.get(link.evidenceId)
      if (!material) return []
      if (catalogBound && (named.length !== 1 || named[0].id !== material.id)) return []
      const insight = insights.get(material.id)
      if (insight?.materialRole === 'working_draft' || (insight?.materialRole === 'identity' && declaration.type !== 'E-SUBJ')) return []
      if (differentPaymentPeriod(declaration.quote, link.quote) || (link.relation !== 'contradict'
        && paymentKind.test(declaration.quote) && paymentKind.test(link.quote) && differentField(declaration.quote, link.quote, party))) return []
      const fragments = fragmentsByMaterial.get(material.id) ?? []
      const atLocator = fragments.filter(item => item.locator === link.locator)
      if (!(fragments.length ? atLocator.some(item => textBound(item.text, link.quote)) : textBound(material.ocrText, link.quote))) return []
      const locator = atLocator.length || link.locator === material.anchorHint ? link.locator : '材料全文 · 按原文定位'
      if (declaration.type === 'E-ERR' && (!priorLocator.test(locator) || !priorMaterial.test(`${material.name}\n${material.fileName}`))) return []
      return [{ material, source: sourceFor(material, link.quote, locator), relation: link.relation }]
    })
    if (named.length === 1 && !linked.some(item => item.material.id === named[0].id)) linked.push({ material: named[0], source: sourceFor(named[0], undefined, named[0].anchorHint) })
    const sources = linked.map(item => item.source)
    const checks = { ...declaration.checks }
    const set = (code: `A${1 | 2 | 3 | 4 | 5}`, outcome: CheckOutcome, reason: string) => { checks[code] = { outcome, reason } }
    const actual = linked.find(item => item.relation === 'support' && item.source.quote) ?? linked.find(item => item.source.quote)
    const reference = actual?.source.quote || ''
    const contradiction = linked.find(item => item.relation === 'contradict')
    const absolute = paymentDenial(declaration.quote)
    const laterSource = !contradiction && absolute && linked.find(({ source, relation }) => relation !== 'context' && source.quote
      && getLinkageSentences(source.quote).some(({ sentenceText }) => {
        const payment = observedPayment(sentenceText)
        return payment && isLaterPayment(absolute, payment)
      }))?.source.quote
    const debt = type === 'E-CALC' ? declaration.quote.match(claimedDebt) : null
    const paid = debt && declaration.quote.match(statedTradePayment)
    const balance = paid ? tradeBalance(linked) : undefined
    const comparison = compare(declaration.quote, contradiction?.source.quote ?? reference)
    const differences = laterSource || (debt && !contradiction) ? [] : comparison.differences
    if (laterSource) differences.push({ field: '后续付款', document: declaration.quote, source: laterSource })
    const balanceReason = balance ? `结算单复算：${balance.total / 100} − ${balance.paid / 100} = ${balance.amount / 100} 元。` : undefined
    if (balance && debt && paid) {
      if (moneyInCents(debt) !== balance.amount) differences.push({ field: '欠款', document: `${debt[1]}${debt[2] ?? ''}元`, source: `${balance.amount / 100}元` })
      if (moneyInCents(paid) !== balance.paid) differences.push({ field: '实付货款', document: `${paid[1]}${paid[2] ?? ''}元`, source: `${balance.paid / 100}元` })
    }
    const balanceConflict = Boolean(balance && differences.length)
    const reversed = type === 'E-ERR' ? reversal(declaration.quote, reference) : undefined
    if (reversed) differences.push(...reversed)
    const purpose = type === 'E-PURP' ? purposeCheck(declaration, linked) : undefined
    const insufficientSigner = /法定代表人[^。；]{0,10}签收/u.test(declaration.quote)
      && /签收/u.test(reference) && (!/法定代表人/u.test(reference) || /(?:并非|不是|非)法定代表人/u.test(reference))
    const incoherent = absolute && payments.find(item => isLaterPayment(absolute, item))
    const challenged = type === 'E-CROSS' && /^对(?:方)?证据\s*(\d+)\s*([^：:\n]{1,40})[：:]/u.exec(declaration.quote)
    const ghostAttack = Boolean(challenged && opposing && !sources.length && !opposing.numbers.has(Number(challenged[1]))
      && !opposing.names.has(evidenceName(challenged[2])) && !nameMatches(challenged[2]).length)
    const unsupportedChallenge = type === 'E-CROSS' && /(?:可能|怀疑|存疑)[^。；]{0,10}(?:篡改|伪造)|(?:篡改|伪造)[^。；]{0,10}(?:可能|存疑)/u.test(declaration.quote)
    const unsupportedChallengeReason = '质疑缺少可定位的具体瑕疵，请指出原文、载体或比对依据。'
    const formula = type === 'E-CALC' ? declaration.quote.match(interestFormula) : null
    const interest = formula ? localCalculation(formula, linked) : undefined
    const calculation = interest ?? (balance && {
      kind: 'trade-balance' as const, total: balance.total / 100, paid: balance.paid / 100, amount: balance.amount / 100, sources: balance.sources,
    })
    const stated = formula && declaredInterest.exec(declaration.quote.slice((formula.index ?? 0) + formula[0].length))
    const calculationConflict = interest && stated && moneyInCents(stated) !== Math.round(interest.amount * 100)
      ? { field: '计息结果', document: `${stated[1]}${stated[2] ?? ''}元`, source: `${interest.amount}元` } : undefined
    if (calculationConflict) differences.push(calculationConflict)

    const sameSourceConflict = Boolean(contradiction || laterSource || reversed || calculationConflict || balanceConflict)
    const partialFields = Boolean(reference && comparison.incomplete && !debt && (type === 'E-FACT' || type === 'E-CROSS'))
    const partialSource = insufficientSigner || (!sameSourceConflict && (partialFields || differences.length > 0))
    set('A1', !sources.length ? 'miss' : partialSource ? 'warn' : 'pass', !sources.length ? '没有可回查的对应材料或前审段落。'
      : partialSource ? '出处可回查，部分要素尚待核实。' : '出处可回查。')
    if (checks.A2 || sameSourceConflict || partialSource) set('A2', sameSourceConflict ? 'fail' : partialSource ? 'warn' : reference ? 'pass' : 'pending',
      reversed ? '文书转述反转了原审认定、判项或责任性质。' : laterSource ? '卷内原文记载该主体的后续付款，与文书说法矛盾。'
        : contradiction ? '文书与原材料存在冲突。'
        : balanceConflict ? `正文金额与结算记录不符。${balanceReason}` : calculationConflict ? '正文计息金额与有来源支持的算式不符。'
          : insufficientSigner ? `签收人身份未证实，请按签收记录改写「${reference.slice(0, 160)}」。`
            : comparison.summary ? `${comparison.summary}。` : '按同一出处核对文本与字段。')
    if (catalogEntry) set('A3', named.length === 1 ? 'pass' : 'miss', named.length === 1 ? '清单行可对应卷内材料。' : '清单行缺少唯一对应的卷内材料。')
    else if (checks.A3) set('A3', 'not-applicable', '该声明不属于证据清单行。')
    if (purpose) set('A4', purpose.outcome, purpose.reason)
    else if (unsupportedChallenge && sources.length) set('A4', 'warn', unsupportedChallengeReason)
    else if (checks.A4) set('A4', 'not-applicable', '该声明未列单独的证明目的。')
    if (checks.A5 || incoherent) set('A5', incoherent ? 'fail' : 'pass', incoherent
      ? `第${declaration.location.paragraphIndex + 1}段第${(declaration.location.sentenceIndex ?? 0) + 1}句声称未再付款，第${incoherent.paragraphIndex + 1}段第${incoherent.sentenceIndex + 1}句记载后续付款。`
      : '未检出受控付款时序矛盾。')

    const support = linked.some(item => item.relation === 'support' && item.source.quote)
    const failedCheck = Object.values(checks).find(check => check.outcome === 'fail')
    let verdict: Declaration['verdict'] = paragraph.note?.trim() ? 'note' : 'pass'
    let reason = balanceReason ?? '已核对原材料及对应位置。'
    if (failedCheck || ghostAttack) {
      verdict = 'fail'
      reason = failedCheck?.reason ?? '对方的完整证据目录和卷内材料均无该质证对象。'
    } else if (type === 'E-CALC' && !calculation) {
      verdict = 'warn'
      reason = debt ? '欠款复算需要来源支持的货款总额和累计实付记录。' : '缺少来源支持的基数、利率、期间或计息公式。'
    } else if (!sources.length || purpose?.outcome === 'miss') {
      verdict = 'miss'
      reason = purpose?.reason ?? checks.A1?.reason ?? declaration.reason
    } else if (partialSource || unsupportedChallenge || purpose?.outcome === 'warn' || (type !== 'E-EVID' && !purpose && !support)) {
      verdict = 'warn'
      reason = partialSource ? checks.A2?.reason ?? declaration.reason : unsupportedChallenge ? unsupportedChallengeReason
        : purpose?.reason ?? checks.A2?.reason ?? '已定位材料，仍需核对其证明范围。'
    } else if (!paragraph.verified) {
      verdict = 'pending'
      reason = '已关联出处，待律师核对。'
    }
    return { ...declaration, checks, verdict, sources, reason,
      differences: differences.length ? differences : undefined, calculation }
  })
  return { declarations: verified, documentDiagnostics }
}
