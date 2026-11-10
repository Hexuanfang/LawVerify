import { splitEvidenceTextIntoPages } from '../src/intelligence/evidence-retrieval.js'
import { getSentenceLinkageGuard } from '../src/intelligence/linkage-policy.js'
import { evidenceSourceNumber } from '../src/intelligence/case-agent.js'
import { normalizeForMatch, tokenize } from '../src/search/tokenize.js'

export type EvalRelation = 'support' | 'partial' | 'contradict' | 'unrelated'

export interface EvalMaterial {
  id: string
  number: string
  sourceNumber?: string
  name: string
  type: string
  relativePath?: string
  text: string
}

export interface EvalClaim {
  id: string
  paragraphId: string
  sentenceIndex: number
  sentenceText: string
  expect: {
    /** 该句是否需要进入联动核验（与句级门控 guard 的口径一致） */
    link: boolean
    /** 应挂接的材料；null 表示无需或无法指向具体材料 */
    materialId: string | null
    locator?: string
    relation: EvalRelation
    statutes?: string[]
    cases?: string[]
  }
  notes?: string
}

export interface EvalSample {
  id: string
  corpus: string
  case: { name: string; role: string }
  materials: EvalMaterial[]
  paragraphs: Array<{ id: string; text: string }>
  claims: EvalClaim[]
}

export interface MetricFailure {
  id: string
  reason: string
}

export interface MetricResult {
  key: string
  label: string
  value: number
  total: number
  correct: number
  failures: MetricFailure[]
  /** 补充说明，例如不可用样本数量 */
  notes?: string
}

export interface FixtureLink {
  materialId: string
  locator: string
  quote: string
  relation?: string
  sentenceIndex?: number
}

export interface FixtureEntry {
  id: string
  sampleId: string
  kind: string
  stage: 'overview' | 'links'
  paragraphIds: string[]
  raw: string
  expectParse: boolean
  links?: FixtureLink[]
}

function ratio(correct: number, total: number) {
  return total > 0 ? correct / total : 0
}

function emptyResult(key: string, label: string, note: string): MetricResult {
  return { key, label, value: 0, total: 0, correct: 0, failures: [], notes: note }
}

/* ------------------------------------------------------------------ */
/* M1 候选召回                                                          */
/* ------------------------------------------------------------------ */

function materialDocument(material: EvalMaterial) {
  return [material.name, material.relativePath ?? '', material.text].join('\n')
}

/**
 * 材料级 BM25 排序：与证据检索层共用分词实现，
 * 保证评测里的「候选召回」和线上检索的匹配口径一致。
 */
export function rankMaterialCandidates(query: string, materials: EvalMaterial[], limit: number): string[] {
  if (!materials.length) {
    return []
  }

  const tokenized = materials.map(material => tokenize(materialDocument(material)))
  const lengths = tokenized.map(tokens => tokens.length)
  const averageLength = lengths.reduce((total, length) => total + length, 0) / tokenized.length
  const queryTokens = [...new Set(tokenize(query))]
  if (!queryTokens.length) {
    return []
  }

  const k1 = 1.2
  const b = 0.75
  const scores = new Map<number, number>()

  for (const token of queryTokens) {
    const posting: number[] = []
    tokenized.forEach((tokens, index) => {
      if (tokens.includes(token)) {
        posting.push(index)
      }
    })
    if (!posting.length) {
      continue
    }

    const idf = Math.log(1 + (materials.length - posting.length + 0.5) / (posting.length + 0.5))
    for (const index of posting) {
      const frequency = tokenized[index].filter(item => item === token).length
      const length = lengths[index] || 1
      const denominator = frequency + k1 * (1 - b + b * (length / (averageLength || 1)))
      const score = idf * ((frequency * (k1 + 1)) / (denominator || 1))
      scores.set(index, (scores.get(index) ?? 0) + score)
    }
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, Math.max(0, limit))
    .map(([index]) => materials[index].id)
}

export function evaluateRecall(samples: EvalSample[], topK = 5): MetricResult {
  let total = 0
  let correct = 0
  const failures: MetricFailure[] = []

  for (const sample of samples) {
    for (const claim of sample.claims) {
      if (!claim.expect.link || !claim.expect.materialId) {
        continue
      }
      total += 1
      const candidates = rankMaterialCandidates(claim.sentenceText, sample.materials, topK)
      if (candidates.includes(claim.expect.materialId)) {
        correct += 1
      } else {
        failures.push({
          id: claim.id,
          reason: `期望材料 ${claim.expect.materialId} 未进入 top${topK}（实际候选：${candidates.join(', ') || '无'}）`,
        })
      }
    }
  }

  return {
    key: 'recall_at_5',
    label: `候选召回 recall@${topK}`,
    value: ratio(correct, total),
    total,
    correct,
    failures,
    notes: total ? `共 ${total} 条应挂接材料的主张句参与计分` : '没有可计分样本',
  }
}

/* ------------------------------------------------------------------ */
/* M2 句级门控                                                          */
/* ------------------------------------------------------------------ */

export function evaluateGating(samples: EvalSample[]): MetricResult {
  let total = 0
  let correct = 0
  const failures: MetricFailure[] = []

  for (const sample of samples) {
    for (const claim of sample.claims) {
      total += 1
      const guard = getSentenceLinkageGuard(claim.sentenceText)
      const expectSkip = !claim.expect.link
      if (guard.skip === expectSkip) {
        correct += 1
      } else {
        failures.push({
          id: claim.id,
          reason: `门控结论不一致：guard=${guard.kind}/${guard.skip ? 'skip' : 'link'}，期望=${expectSkip ? 'skip' : 'link'}`,
        })
      }
    }
  }

  return {
    key: 'gating_accuracy',
    label: '句级门控准确率',
    value: ratio(correct, total),
    total,
    correct,
    failures,
    notes: `共 ${total} 条主张句参与计分`,
  }
}

/* ------------------------------------------------------------------ */
/* M3 引用可溯                                                          */
/* ------------------------------------------------------------------ */

/** 解析「第 2 页」「第 1-3 页」这类定位；返回 null 表示全文定位 */
export function parseLocatorPages(locator: string): number[] | null {
  const normalized = locator.replace(/\s+/g, '')
  if (!normalized || /全文|全部|整篇/.test(normalized)) {
    return null
  }
  const matched = normalized.match(/第?(\d+)(?:[-~至](\d+))?页/)
  if (!matched) {
    return null
  }
  const start = Number(matched[1])
  const end = matched[2] ? Number(matched[2]) : start
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null
  }
  const pages: number[] = []
  for (let page = start; page <= end; page += 1) {
    pages.push(page)
  }
  return pages
}

/** 判断一条挂接是否真的落在材料原文里：定位能解析、引用是原文子串 */
export function checkLinkGrounded(material: EvalMaterial | undefined, locator: string, quote: string) {
  if (!material) {
    return { grounded: false, reason: '挂接指向的材料不存在' }
  }
  const normalizedQuote = normalizeForMatch(quote)
  if (normalizedQuote.length < 4) {
    return { grounded: false, reason: '引用过短，无法在原文中定位' }
  }

  const pages = parseLocatorPages(locator)
  const pageTexts = splitEvidenceTextIntoPages(material.text)
  let candidate = material.text

  if (pages) {
    const picked = pageTexts.filter(page => page.page !== undefined && pages.includes(page.page))
    if (!picked.length) {
      return { grounded: false, reason: `定位「${locator}」在材料中不存在` }
    }
    candidate = picked.map(page => page.content).join('\n')
  }

  if (!normalizeForMatch(candidate).includes(normalizedQuote)) {
    return { grounded: false, reason: `引用未在${pages ? `第 ${pages.join('、')} 页` : '材料正文'}中原文出现` }
  }

  return { grounded: true, reason: '' }
}

export function evaluateGrounding(samples: EvalSample[], links: Array<FixtureLink & { id: string; sampleId: string }>): MetricResult {
  let total = 0
  let correct = 0
  const failures: MetricFailure[] = []

  for (const link of links) {
    const sample = samples.find(item => item.id === link.sampleId)
    const material = sample?.materials.find(item => item.id === link.materialId)
    total += 1
    const result = checkLinkGrounded(material, link.locator, link.quote)
    if (result.grounded) {
      correct += 1
    } else {
      failures.push({ id: link.id, reason: result.reason })
    }
  }

  if (!total) {
    return emptyResult('grounded_rate', '引用可溯率', '没有离线挂接样本')
  }

  return {
    key: 'grounded_rate',
    label: '引用可溯率',
    value: ratio(correct, total),
    total,
    correct,
    failures,
    notes: `共 ${total} 条挂接参与计分`,
  }
}

/* ------------------------------------------------------------------ */
/* M4 编号一致性                                                        */
/* ------------------------------------------------------------------ */

export function evaluateNumbering(samples: EvalSample[]): MetricResult {
  let total = 0
  let correct = 0
  const failures: MetricFailure[] = []

  for (const sample of samples) {
    const numberCounts = new Map<string, number>()
    const sourceCounts = new Map<string, number>()
    for (const material of sample.materials) {
      numberCounts.set(material.number, (numberCounts.get(material.number) ?? 0) + 1)
      if (material.sourceNumber) {
        sourceCounts.set(material.sourceNumber, (sourceCounts.get(material.sourceNumber) ?? 0) + 1)
      }
    }

    for (const material of sample.materials) {
      total += 1
      const derived = evidenceSourceNumber(material.relativePath ?? material.name)
      const problems: string[] = []

      if ((derived ?? undefined) !== (material.sourceNumber ?? undefined)) {
        problems.push(`引用编号不一致：路径推断为 ${derived ?? '无'}，数据声明为 ${material.sourceNumber ?? '无'}`)
      }
      if (!/^[EX]\d{2,3}$/.test(material.number)) {
        problems.push(`目录编号格式非法：${material.number}`)
      }
      if ((numberCounts.get(material.number) ?? 0) > 1) {
        problems.push(`目录编号重复：${material.number}`)
      }
      if (material.sourceNumber && (sourceCounts.get(material.sourceNumber) ?? 0) > 1) {
        problems.push(`引用编号重复：${material.sourceNumber}`)
      }

      if (!problems.length) {
        correct += 1
      } else {
        failures.push({ id: `${sample.id}/${material.id}`, reason: problems.join('；') })
      }
    }
  }

  return {
    key: 'numbering_accuracy',
    label: '编号一致性准确率',
    value: ratio(correct, total),
    total,
    correct,
    failures,
    notes: `共 ${total} 份材料参与计分`,
  }
}

/* ------------------------------------------------------------------ */
/* M5 解析健壮率                                                        */
/* ------------------------------------------------------------------ */

/** 判断一份原始模型响应是否解析成功（由注入的解析器决定，避免评测耦合实现） */
export type ParseFn = (raw: string, paragraphIds: string[], stage: 'overview' | 'links') => Array<{ paragraphId: string }>

export function evaluateParseSuccess(entries: FixtureEntry[], parse: ParseFn): MetricResult {
  const expected = entries.filter(entry => entry.expectParse)
  let correct = 0
  const failures: MetricFailure[] = []

  for (const entry of expected) {
    const parsed = parse(entry.raw, entry.paragraphIds, entry.stage)
    if (parsed.length) {
      correct += 1
    } else {
      failures.push({ id: entry.id, reason: `未能解析出段落结果（kind=${entry.kind}）` })
    }
  }

  const rejected = entries.filter(entry => !entry.expectParse)
  let rejectedCorrect = 0
  for (const entry of rejected) {
    if (!parse(entry.raw, entry.paragraphIds, entry.stage).length) {
      rejectedCorrect += 1
    }
  }

  return {
    key: 'parse_success_rate',
    label: '解析健壮率',
    value: ratio(correct, expected.length),
    total: expected.length,
    correct,
    failures,
    notes: rejected.length
      ? `另有 ${rejected.length} 条应当被拒绝的脏响应，其中 ${rejectedCorrect} 条正确未产出结果`
      : '没有应当被拒绝的脏响应',
  }
}

/* ------------------------------------------------------------------ */
/* 语料自检                                                              */
/* ------------------------------------------------------------------ */

export interface DatasetIssue {
  sampleId: string
  claimId: string
  reason: string
}

/**
 * 语料自检：确认主张句与段落正文能按 getLinkageSentences 的口径对上。
 * 语料本身写错时，指标没有意义，所以先把它当成一道前置校验。
 */
export function checkDatasetConsistency(samples: EvalSample[]): DatasetIssue[] {
  const issues: DatasetIssue[] = []
  for (const sample of samples) {
    const paragraphMap = new Map(sample.paragraphs.map(paragraph => [paragraph.id, paragraph]))
    const materialIds = new Set(sample.materials.map(material => material.id))
    for (const claim of sample.claims) {
      const paragraph = paragraphMap.get(claim.paragraphId)
      if (!paragraph) {
        issues.push({ sampleId: sample.id, claimId: claim.id, reason: `段落 ${claim.paragraphId} 不存在` })
        continue
      }
      const sentences = Array.from(paragraph.text.replace(/\r/g, '').matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu))
        .map(match => match[0].trim())
        .filter(Boolean)
      const sentence = sentences[claim.sentenceIndex]
      if (!sentence) {
        issues.push({ sampleId: sample.id, claimId: claim.id, reason: `段落 ${claim.paragraphId} 没有第 ${claim.sentenceIndex} 句` })
        continue
      }
      if (normalizeForMatch(sentence) !== normalizeForMatch(claim.sentenceText)) {
        issues.push({
          sampleId: sample.id,
          claimId: claim.id,
          reason: `句子文本与段落不一致：期望「${claim.sentenceText}」，实际「${sentence}」`,
        })
      }
      if (claim.expect.materialId && !materialIds.has(claim.expect.materialId)) {
        issues.push({ sampleId: sample.id, claimId: claim.id, reason: `期望材料 ${claim.expect.materialId} 不存在` })
      }
    }
  }
  return issues
}
