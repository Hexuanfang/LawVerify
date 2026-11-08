import type { EvidenceRiskFinding, EvidenceRiskKind } from '../domain.js'

type RiskRule = {
  kind: EvidenceRiskKind
  severity: EvidenceRiskFinding['severity']
  message: string
  pattern: RegExp
}

// 规则化风险扫描：程序瑕疵与形式要件问题不会出现在争议焦点的语义空间里，
// 必须独立于检索链单独扫描，否则超大材料只理解命中块时这些风险会被漏掉。
const RISK_RULES: RiskRule[] = [
  {
    kind: 'limitation-deadline',
    severity: 'high',
    message: '材料涉及举证期限，请核对举证期是否已届满以及逾期举证的后果。',
    pattern: /举证期限|举证期(?:限)?(?:届满|尚未届满)|应当(?:在|于)[^。；\n]{0,20}日内(?:举证|提供)|收到[^。；\n]{0,20}之日起[^。；\n]{0,10}日内/u,
  },
  {
    kind: 'evidence-form',
    severity: 'high',
    message: '材料可能涉及法定形式要件（书面、公证、鉴定等），请核对是否满足受理与证明要求。',
    pattern: /无法定形式|应当采用书面形式|应采用书面形式|书面形式(?:的)?(?:证据|材料)|公证(?:处)?(?:保全|认证)|(?:司法)?鉴定(?:意见|机构)|须经[^。；\n]{0,10}(?:公证|认证|鉴定)/u,
  },
  {
    kind: 'original-missing',
    severity: 'medium',
    message: '材料出现复印件、扫描件或照片，需核对原件是否留存、原件能否当庭出示。',
    pattern: /复印件|扫描件|翻拍|照片打印|影印件/u,
  },
  {
    kind: 'signature-seal',
    severity: 'medium',
    message: '材料涉及签章，请核对签字、盖章是否齐全以及签署人是否有授权。',
    pattern: /签(?:字|名|章)|盖(?:章|印)|骑缝章|印章|签署人/u,
  },
  {
    kind: 'page-continuity',
    severity: 'medium',
    message: '材料出现页码信息，请核对页码是否连续、有无缺页或抽换页。',
    pattern: /第\s*[0-9一二三四五六七八九十百]+\s*页|页码|共\s*[0-9一二三四五六七八九十百]+\s*页/u,
  },
  {
    kind: 'delivery-address',
    severity: 'medium',
    message: '材料涉及送达信息，请核对送达地址、送达方式是否明确且可核实。',
    pattern: /送达地址|送达方式|邮寄地址|电子送达|受送达人|按址送达|留置送达/u,
  },
  {
    kind: 'party-identity',
    severity: 'low',
    message: '材料涉及当事人身份信息，请核对主体名称与证件信息是否完整、是否与主张主体一致。',
    pattern: /统一社会信用代码|身份证(?:号码?)?|法定代表人|当事人(?:信息|基本情况)|主体资格/u,
  },
]

const HIGH_RISK_SIGNATURE = /未(?:经)?(?:签字|签名|盖章)|(?:无|缺少|缺失)(?:签字|签名|盖章|签章)|签章(?:缺失|不全)|未加盖(?:公章|单位章)/u
const ORIGINAL_PRESENT = /原件(?:已|均)?(?:核对|留存|当庭出示|提交|移交)|已核对原件|与原件核对无误/u

function findExcerpt(text: string, pattern: RegExp) {
  const matched = pattern.exec(text)
  if (!matched) {
    return undefined
  }

  const start = Math.max(0, matched.index - 20)
  return text.slice(start, Math.min(text.length, matched.index + matched[0].length + 20)).trim()
}

export function scanEvidenceRisks(text: string): EvidenceRiskFinding[] {
  const normalized = text?.replace(/\r\n/g, '\n') ?? ''
  if (!normalized.trim()) {
    return []
  }

  const findings: EvidenceRiskFinding[] = []
  for (const rule of RISK_RULES) {
    const matched = rule.pattern.exec(normalized)
    if (!matched) {
      continue
    }

    // 已经出现原件核验结论时不再提示原件缺失，避免误报。
    if (rule.kind === 'original-missing' && ORIGINAL_PRESENT.test(normalized)) {
      continue
    }

    const severity = rule.kind === 'signature-seal' && HIGH_RISK_SIGNATURE.test(normalized)
      ? 'high'
      : rule.severity
    findings.push({
      kind: rule.kind,
      severity,
      message: severity === 'high' && rule.kind === 'signature-seal'
        ? '材料显示签字或盖章缺失，此类瑕疵可能被直接否认其真实性或效力。'
        : rule.message,
      excerpt: findExcerpt(normalized, rule.pattern),
    })
  }

  return findings
}
