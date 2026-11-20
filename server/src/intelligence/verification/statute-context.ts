import type { StatuteDetailResult } from '../../integrations/legal-statute.js'
import type { Declaration } from './protocol.js'
import { reviewedVerdict } from './review-status.js'
import { checkStatuteHierarchy } from './statute-hierarchy.js'

type Check = NonNullable<Declaration['checks']['B4']>
type Basis = 'loan' | 'sale' | 'interest' | 'breach' | 'appeal'
type Detail = Extract<StatuteDetailResult, { outcome: 'found' }>['item']

const basisName: Record<Basis, string> = { loan: '借款本金返还', sale: '买卖价款支付', interest: '利息', breach: '违约责任', appeal: '二审救济' }

function groundsOfRequest(text: string): Basis[] {
  const bases: Basis[] = []
  if (/(?:返还|偿还|归还)[^，。；]{0,12}(?:借款|借贷)(?:本金)?/u.test(text)) bases.push('loan')
  if (/(?:支付|给付|清偿)[^，。；]{0,10}(?:货款|买卖价款)/u.test(text)) bases.push('sale')
  if (/(?:支付|给付|偿还|承担)[^，。；]{0,20}利息/u.test(text)) bases.push('interest')
  if (/(?:承担|赔偿|支付)[^，。；]{0,12}(?:违约责任|违约金|违约损失)/u.test(text)) bases.push('breach')
  if (/(?:撤销原判|撤销原裁定|发回重审|依法改判|并改判)/u.test(text)) bases.push('appeal')
  return bases
}

function groundsOfProvision(text: string): Basis[] {
  const bases: Basis[] = []
  if (/借款人[^。；]{0,80}应当[^。；]{0,80}(?:返还|偿还|归还)借款/u.test(text)) bases.push('loan')
  if (/买受人[^。；]{0,90}支付(?:价款|货款)/u.test(text)) bases.push('sale')
  if (/借款人[^。；]{0,90}支付利息|借款的利息|借款合同[^。；]{0,40}利息/u.test(text)) bases.push('interest')
  if (/(?:不履行合同义务|履行合同义务不符合约定)[^。；]{0,100}(?:违约责任|赔偿损失)/u.test(text)) bases.push('breach')
  if (/^\s*第二审人民法院对上诉案件/u.test(text) && /(?:改判|发回重审|撤销)/u.test(text)) bases.push('appeal')
  return bases
}

export function supportsContractBreach(text: string) {
  return groundsOfProvision(text).includes('breach')
}

export function matchesProvisionGrounds(original: string, candidate: string) {
  const required = groundsOfProvision(original)
  const offered = groundsOfProvision(candidate)
  return required.length > 0 && required.length === offered.length && required.every(basis => offered.includes(basis))
}

const sameSentence = (left: Declaration, right: Declaration) => left.location.paragraphId === right.location.paragraphId
  && (left.location.sentenceIndex === undefined || right.location.sentenceIndex === undefined || left.location.sentenceIndex === right.location.sentenceIndex)
const trustedFact = (item: Declaration) => ['pass', 'note'].includes(reviewedVerdict(item)) && item.sources.some(source => source.tier === 'l1')
const sameParagraph = (left: Declaration, right: Declaration) => left.location.paragraphId === right.location.paragraphId

function requestForCitation(law: Declaration, requests: Declaration[]) {
  const direct = requests.filter(item => sameSentence(law, item))
  if (direct.length) return direct.length === 1 ? direct[0] : undefined
  const local = requests.filter(item => sameParagraph(law, item))
  if (local.length) return local.length === 1 ? local[0] : undefined
  return requests.length === 1 ? requests[0] : undefined
}

function scopedFacts(law: Declaration, request: Declaration | undefined, declarations: Declaration[]) {
  const facts = declarations.filter(item => item.type === 'E-FACT' && !/另案|其他案件/u.test(item.quote))
  if (!request) return facts.filter(item => sameSentence(law, item))
  const local = facts.filter(item => sameParagraph(law, item) || sameParagraph(request, item))
  const requests = declarations.filter(item => item.type === 'E-CLAIM')
  return requests.length === 1 ? facts : local.filter(fact => (sameSentence(request, fact) || sameSentence(law, fact))
    || requests.filter(item => sameParagraph(fact, item)).every(item => item.id === request.id))
}

const contract = /借款合同|借款协议|买卖合同|合同约定|签订合同/u
const defaulted = /(?:到期|期满)[^。；]{0,12}未(?:履行|偿还|归还|返还|支付)|未按(?:合同|约定)[^。；]{0,12}履行/u

export function hasVerifiedContractBreach(law: Declaration, declarations: Declaration[]) {
  const requests = declarations.filter(item => item.type === 'E-CLAIM')
  const request = requestForCitation(law, requests)
  if (requests.length && (!request || !groundsOfRequest(request.quote).includes('breach'))) return false
  return scopedFacts(law, request, declarations).some(fact => trustedFact(fact) && contract.test(fact.quote) && defaulted.test(fact.quote))
}

function checkAdaptation(law: Declaration, item: Detail, declarations: Declaration[], docKey?: string) {
  const scope = groundsOfProvision(item.text)
  const claim = requestForCitation(law, declarations.filter(entry => entry.type === 'E-CLAIM'))
  const requested = claim ? groundsOfRequest(claim.quote) : []
  const applicable = scope.filter(basis => requested.includes(basis))
  const signals: Record<Basis, RegExp> = { loan: /借款|借贷|出借|转账|还款/u, sale: /买卖|货物|交货|收货|货款|价款/u,
    interest: /借款|利息|利率|还款/u, breach: /合同|履行|违约/u, appeal: /原判|原审|一审|判决|裁定/u }
  // 请求没有覆盖条文所涉要件时，仍跟踪该条文相关事实，后续据此重开 B4。
  const relevantBases = applicable.length ? applicable : scope
  const facts = scopedFacts(law, claim, declarations).filter(fact => relevantBases.some(basis => signals[basis].test(fact.quote)))
  const result = (outcome: Check['outcome'], reason: string, dependencies = facts) => ({ check: { outcome, reason },
    dependencies: dependencies.map(fact => ({ id: fact.id, check: 'B4' as const })) })
  if (docKey === 'ss' && requested.includes('appeal') && /^[^。；]{0,35}第一审人民法院/u.test(item.text)
    && !/第二审人民法院/u.test(item.text)) return result('fail', '本项上诉请求引用了只约束第一审的程序条文。')
  if ((scope.includes('loan') && requested.includes('sale') && !requested.includes('loan'))
    || (scope.includes('sale') && requested.includes('loan') && !requested.includes('sale'))) {
    return result('fail', '条文针对的法律关系与本项请求不一致。')
  }
  if (facts.some(fact => ['fail', 'miss', 'pending'].includes(reviewedVerdict(fact)))) return result('pending', '相关依赖事实仍待核验。')
  if (applicable.length) {
    const available = facts.filter(trustedFact)
    const supported = applicable.map(basis => available.find(fact => supportsRequirements(basis, fact.quote)))
    if (supported.every(fact => fact !== undefined)) return result('pass', '已核事实支持本项请求所引条文的适用要件。', [...new Set(supported)])
    const missing = applicable.filter((_, index) => !supported[index])
    return result('warn', `条文与请求类型相符，尚需核实${missing.map(basis => basisName[basis]).join('、')}的具体适用要件。`)
  }
  return result('pending', '尚需结合已核事实复核构成要件和适用范围。')
}

function supportsRequirements(basis: Basis, fact: string) {
  if (basis === 'breach') return contract.test(fact) && defaulted.test(fact)
  const affirmed = fact.split(/[，,。；;]/u).map(clause => clause.replace(/\s/gu, ''))
    .filter(clause => !/(?:未|没有|不曾|否认)[^。；]{0,8}(?:交付|支付|转账|到账|收到|签收|届满|到期)/u.test(clause)).join('；')
  const loanPaid = /(?:交付|支付|转账|收到)[^。；]{0,12}借款|借款[^。；]{0,12}(?:已交付|已到账)/u.test(affirmed)
  const maturity = /(?:还款期|还款期限|还款日)[^。；]{0,8}(?:已届满|已到期|届满|到期)/u.test(affirmed)
  if (basis === 'loan') return loanPaid && maturity
  if (basis === 'interest') return loanPaid && /约定[^。；]{0,16}(?:利息|利率)/u.test(affirmed) && /(?:利息|付息)[^。；]{0,16}(?:已到期|已届满)/u.test(affirmed)
  if (basis === 'sale') return /(?:已交付|交付了|已收到|签收)[^。；]{0,12}(?:货物|货品)|货物[^。；]{0,10}(?:已签收|已交付)/u.test(affirmed)
    && /约定[^。；]{0,12}(?:货款|价款)|(?:货款|价款)约定/u.test(affirmed)
  return false
}

export function assessStatuteContext(law: Declaration, paragraph: string, item: Detail, declarations: Declaration[], docKey?: string) {
  const { check, dependencies } = checkAdaptation(law, item, declarations, docKey)
  const request = requestForCitation(law, declarations.filter(entry => entry.type === 'E-CLAIM'))
  const regionalFacts = scopedFacts(law, request, declarations).filter(trustedFact).map(fact => fact.quote)
  return { B4: check, B5: checkStatuteHierarchy(law, paragraph, item, regionalFacts), dependencies }
}

export function requestBasisChecks(declarations: Declaration[]) {
  const byDeclaration = new Map<string, Check>()
  const dependencies = new Map<string, NonNullable<Declaration['dependencies']>>()
  const claims = declarations.filter(item => item.type === 'E-CLAIM')
  const requests = claims.map(item => ({ item, required: groundsOfRequest(item.quote) }))
  const laws = declarations.filter(item => item.type === 'E-LAW').map(item => ({ item,
    request: requestForCitation(item, claims),
    covered: groundsOfProvision(item.sources.find(source => source.tier === 'l2')?.quote ?? ''),
    usable: item.checks.B1?.outcome === 'pass' && item.checks.B2?.outcome === 'pass'
      && [item.checks.B3, item.checks.B4, item.checks.B5].every(check => check?.outcome === 'pass' || check?.outcome === 'warn'),
    viable: ![item.checks.B1, item.checks.B2, item.checks.B3, item.checks.B4, item.checks.B5]
      .some(check => check?.outcome === 'fail' || check?.outcome === 'miss'),
  }))
  for (const request of requests) {
    const relatedLaws = laws.filter(law => law.request?.id === request.item.id)
    const possibleLaws = laws.filter(law => !law.request || law.request.id === request.item.id)
    dependencies.set(request.item.id, possibleLaws.map(({ item }) => ({ id: item.id, check: 'B6' })))
    if (!request.required.length) {
      byDeclaration.set(request.item.id, laws.some(law => law.viable && (!law.request || law.request.id === request.item.id))
        ? { outcome: 'pending', reason: '已识别请求和法条，尚需核对该项请求的具体法律依据。' }
        : { outcome: 'miss', reason: '正文未发现该项请求的法条依据。' })
      continue
    }
    const covered = new Set(relatedLaws.filter(law => law.usable).flatMap(law => law.covered))
    const missing = request.required.filter(basis => !covered.has(basis))
    const awaiting = laws.some(law => law.viable && (!law.request || law.request.id === request.item.id)
      && (law.item.checks.B1?.outcome === 'pending' || (law.covered.some(basis => missing.includes(basis)) && (!law.request || !law.usable))))
    const check: Check = missing.length && awaiting
      ? { outcome: 'pending', reason: '关联法条详情仍待核验，请求依据暂无法确认。' }
      : missing.length ? { outcome: missing.length === request.required.length ? 'miss' : 'warn',
      reason: `该项请求尚缺可核对的${missing.map(basis => basisName[basis]).join('、')}依据。` }
      : { outcome: 'pass', reason: '该项请求的必要依据已核对。' }
    byDeclaration.set(request.item.id, check)
    for (const law of relatedLaws) {
      byDeclaration.set(law.item.id, check)
      dependencies.set(law.item.id, possibleLaws.flatMap(({ item }) =>
        item.id === law.item.id ? [] : [{ id: item.id, check: 'B6' as const }]))
    }
  }
  if (requests.length === 0) {
    for (const law of laws) if (law.item.checks.B1?.outcome === 'pass') {
      byDeclaration.set(law.item.id, { outcome: 'not-applicable', reason: '本次核验范围内未抽取到可关联的请求。' })
    }
  }
  return { checks: byDeclaration, dependencies }
}
