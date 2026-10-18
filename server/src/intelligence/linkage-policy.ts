import type { EvidenceInsight, SentenceLinkageFocus } from '../domain.js'

export function normalizeLinkageText(text: string) {
  return text.replace(/\s+/g, '').toLowerCase()
}

export function getLinkageSentences(text: string) {
  return Array.from(text.replace(/\r/g, '').matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu))
    .map((match) => match[0].trim())
    .filter(Boolean)
    .map((sentenceText, sentenceIndex) => ({ sentenceIndex, sentenceText }))
}

const DISPUTE_SIGNAL = /争议|争执|否认|冒用|伪造|不一致|矛盾|不符|不实|虚假|无权代理|主体资格|实际签署|实际控制|证明责任|真实性|并非|未经授权|未获授权/u
const IDENTITY_FIELD = /^(?:甲方|乙方|丙方|委托方|受托方|服务方|委托人|受托人|身份证号码?|身份号码?|证件号码?|统一社会信用代码|姓名|名称|住所(?:地)?|住址|地址|法定代表人|联系方式|联系电话|手机号|邮编|签名|盖章|签订日期|签订地点)[（(）)\s\u4e00-\u9fa5]{0,12}[：:]/u
const BOILERPLATE = /^(?:双方(?:本着|根据|依据|经友好)|甲乙双方(?:本着|经友好)|本合同(?:一式|未尽事宜|自.*(?:签字|盖章).*生效)|以上(?:内容|意见)(?:供|仅供)|此致|敬礼|特此|附件[：:])/u
const HEADING = /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?(?:委托代理合同|委托合同|代理合同|民事起诉状|答辩状|质证意见|证据目录|当事人信息|基本信息|身份信息|事实与理由|诉讼请求|争议焦点|签署页|委托事项|服务内容|法律依据|案件材料|工作底稿)[。：:]?$/u

// These are exclusion guards, not substitutes for the model's semantic judgment.
export function getSentenceLinkageGuard(sentenceText: string) {
  const text = sentenceText.trim()
  if (!text || HEADING.test(text) || /^[\d\s\-—_]+$/u.test(text)) {
    return { kind: 'heading' as const, skip: true }
  }
  if (IDENTITY_FIELD.test(text) && !DISPUTE_SIGNAL.test(text)) {
    return { kind: 'identity' as const, skip: true }
  }
  if (BOILERPLATE.test(text) && !DISPUTE_SIGNAL.test(text)) {
    return { kind: 'background' as const, skip: true }
  }
  return { kind: 'fact' as const, skip: false }
}

export function resolveExactLinkageSentence(text: string, anchor: { sentenceIndex?: number; sentenceText?: string }) {
  const sentences = getLinkageSentences(text)
  const normalizedText = anchor.sentenceText ? normalizeLinkageText(anchor.sentenceText) : ''
  if (typeof anchor.sentenceIndex === 'number' && Number.isInteger(anchor.sentenceIndex)) {
    const sentence = sentences[anchor.sentenceIndex]
    return sentence && (!normalizedText || normalizeLinkageText(sentence.sentenceText) === normalizedText) ? sentence : null
  }
  if (!normalizedText) {
    return null
  }
  const matches = sentences.filter((sentence) => normalizeLinkageText(sentence.sentenceText) === normalizedText)
  return matches.length === 1 ? matches[0] : null
}

export function normalizeSentenceLinkageFocus(text: string, input: unknown): SentenceLinkageFocus[] {
  const entries = Array.isArray(input) ? input : []
  return getLinkageSentences(text).map((sentence) => {
    const guard = getSentenceLinkageGuard(sentence.sentenceText)
    const raw = entries.find((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const item = entry as Record<string, unknown>
      const anchor = resolveExactLinkageSentence(text, {
        sentenceIndex: typeof item.sentenceIndex === 'number' ? item.sentenceIndex : undefined,
        sentenceText: typeof item.sentenceText === 'string' ? item.sentenceText : undefined,
      })
      return anchor?.sentenceIndex === sentence.sentenceIndex
    }) as Record<string, unknown> | undefined
    const kind = ['fact', 'dispute', 'legal_issue', 'identity', 'background', 'heading'].includes(String(raw?.kind))
      ? raw?.kind as SentenceLinkageFocus['kind']
      : guard.kind
    const priority = !guard.skip && typeof raw?.reason === 'string' && raw.reason.trim() && (raw.priority === 'high' || raw.priority === 'normal')
      && kind !== 'heading' && kind !== 'background' ? raw.priority : 'skip'
    const legalEligible = priority !== 'skip' && (kind === 'dispute' || kind === 'legal_issue')
    return {
      ...sentence,
      kind: guard.skip ? guard.kind : kind,
      priority,
      reason: typeof raw?.reason === 'string' ? raw.reason.trim() : '未确认需要核验的实质事项',
      evidenceNeeded: priority !== 'skip' && raw?.evidenceNeeded === true,
      statuteNeeded: legalEligible && raw?.statuteNeeded === true,
      caseNeeded: legalEligible && raw?.caseNeeded === true,
    }
  })
}

export function getEligibleLinkageAnchor(
  text: string,
  focus: SentenceLinkageFocus[],
  anchor: { sentenceIndex?: number; sentenceText?: string },
  channel: 'evidence' | 'statute' | 'case',
) {
  const sentence = resolveExactLinkageSentence(text, anchor)
  if (!sentence) return null
  const decision = focus.find((item) => item.sentenceIndex === sentence.sentenceIndex
    && normalizeLinkageText(item.sentenceText) === normalizeLinkageText(sentence.sentenceText))
  return decision && decision.priority !== 'skip' && decision[`${channel}Needed`] ? sentence : null
}

export function inferMaterialRoleFromContent(text: string): NonNullable<EvidenceInsight['materialRole']> {
  if (/工作底稿|律师底稿|内部备忘|内部讨论稿|未定稿|草稿|拟稿/u.test(text)) return 'working_draft'
  if (/居民身份证|营业执照|居民户口簿|律师执业证/u.test(text)) return 'identity'
  if (/本人陈述|情况自述|当事人陈述/u.test(text)) return 'party_statement'
  return 'unknown'
}

export function isGroundedLinkageQuote(quote: string | undefined, sources: string[]) {
  const normalized = normalizeLinkageText(quote ?? '')
  return normalized.length >= 6 && sources.some(source => normalizeLinkageText(source).includes(normalized))
}

export function canUseIdentityMaterialForSentence(text: string) {
  return /身份|主体资格|授权|代理(?:权|权限|人身份)|资格|冒用|实际签署|签署(?:人|主体)|签名|签章|本人签(?:订|署)|证件|信用代码/u.test(text)
}

export function normalizeMaterialUnderstanding(input: Partial<EvidenceInsight> | null, fallback: Partial<EvidenceInsight> = {}) {
  const list = (value: unknown, defaultValue: string[] = []) => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()))].slice(0, 8)
    : defaultValue
  const roles = ['source_evidence', 'identity', 'working_draft', 'party_statement', 'reference_material', 'unknown']
  const materialRole = roles.includes(String(input?.materialRole)) ? input!.materialRole : fallback.materialRole ?? 'unknown'
  const proofLimitations = list(input?.proofLimitations, fallback.proofLimitations)
  if (materialRole === 'working_draft' && !proofLimitations.some(item => /底稿|独立证明/u.test(item))) {
    proofLimitations.push('工作底稿仅提供办案线索和待核验主张，不能独立证明争议事实。')
  }
  if (materialRole === 'identity' && !proofLimitations.some(item => /身份|履行/u.test(item))) {
    proofLimitations.push('证件仅用于核验身份或资格，不直接证明交易履行、付款或违约事实。')
  }
  return {
    materialRole,
    proofPurposes: list(input?.proofPurposes, fallback.proofPurposes),
    proofLimitations,
    disputedPoints: list(input?.disputedPoints, fallback.disputedPoints),
  }
}
