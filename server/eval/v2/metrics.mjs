// 标点可归一化，但数字和否定词不得删除；字段与原文均按页核验。
export const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, '')
export const ratio = (a, b) => b ? a / b : null

export function locatorPages(locator, total) {
  const match = normalize(locator).match(/^第([1-9]\d*)(?:[-至]([1-9]\d*))?页$/u)
  if (!match) return null
  const start = Number(match[1]), end = Number(match[2] ?? match[1])
  if (end < start || end > total) return null
  return Array.from({ length: end - start + 1 }, (_, i) => start + i)
}

export function scoreLinks(sample, predictions) {
  let tp = 0, fp = 0, fn = 0, relationCorrect = 0, grounded = 0, pageCorrect = 0, exact = 0, negativeCorrect = 0
  const failures = [], used = new Set()
  const claims = new Map(sample.claims.map(c => [c.id, c]))
  const expectedTotal = sample.claims.reduce((n, c) => n + c.expected.length, 0)
  for (const [i, prediction] of predictions.entries()) {
    const claim = claims.get(prediction.claimId)
    const material = sample.materials.find(m => m.id === prediction.materialId)
    const pages = material && locatorPages(prediction.locator, material.pages.length)
    const quote = normalize(prediction.quote)
    // 引文不可跨页拼接；避免拼接页尾与页首制造原文中不存在的引用。
    const isGrounded = Boolean(pages && quote.length >= 6 && pages.some(p => normalize(material.pages[p - 1]).includes(quote)))
    if (isGrounded) grounded++
    const targetIndex = claim?.expected.findIndex(e => e.materialId === prediction.materialId) ?? -1
    const target = targetIndex >= 0 ? claim.expected[targetIndex] : null
    const relationOk = Boolean(target && target.relation === prediction.relation)
    const pageOk = Boolean(target && pages?.length === 1 && pages[0] === target.page)
    if (relationOk) relationCorrect++
    if (pageOk) pageCorrect++
    const key = `${claim?.id}:${targetIndex}`
    const reasons = [!claim && '未知主张', !material && '未知材料', !target && '错挂或禁挂材料',
      target && !relationOk && '证明关系错误', !pageOk && '页码不符或无效', !isGrounded && '引文不在指定页原文', used.has(key) && '重复挂接'].filter(Boolean)
    if (claim && target && relationOk && pageOk && isGrounded && !used.has(key)) {
      tp++; used.add(key)
    } else {
      fp++; failures.push({ claimId: prediction.claimId, predictionIndex: i, reasons, prediction })
    }
  }
  for (const claim of sample.claims) {
    const missing = claim.expected.filter((_, i) => !used.has(`${claim.id}:${i}`))
    fn += missing.length
    if (missing.length) failures.push({ claimId: claim.id, reasons: ['漏挂'], expected: missing })
    const actual = predictions.filter(p => p.claimId === claim.id)
    if (!missing.length && actual.length === claim.expected.length
      && !failures.some(f => f.claimId === claim.id)) exact++
    if (!claim.expected.length && !actual.length) negativeCorrect++
  }
  return { tp, fp, fn, expectedTotal, predictedTotal: predictions.length,
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn),
    wrongLinkRate: ratio(fp, predictions.length), relationAccuracy: ratio(relationCorrect, predictions.length),
    groundedRate: ratio(grounded, predictions.length), pageAccuracy: ratio(pageCorrect, predictions.length),
    exactMatch: ratio(exact, sample.claims.length),
    negativeAccuracy: ratio(negativeCorrect, sample.claims.filter(c => !c.expected.length).length), failures }
}

// Levenshtein 字符错误率；重复输出会增加插入错误，不能靠重复文本刷召回。
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]))
    row = next
  }
  return row[b.length]
}

export function scoreExtraction(gold, actualPages, metadata = {}) {
  let fields = 0, matched = 0, errors = 0, characters = 0
  const failures = []
  for (const [index, expected] of gold.pages.entries()) {
    const page = index + 1
    const found = actualPages.filter(p => p.page === page)
    const actual = normalize(found.map(p => p.text).join('\n'))
    const target = normalize(expected.text)
    characters += target.length
    errors += editDistance(target, actual)
    for (const field of expected.fields) {
      fields++
      if (actual.includes(normalize(field))) matched++
      else failures.push({ page, field, reason: '关键字段缺失或归属页错误' })
    }
    if (found.length > 1) failures.push({ page, reason: '重复页输出' })
  }
  for (const page of actualPages.filter(p => !Number.isInteger(p.page) || p.page < 1 || p.page > gold.pages.length)) {
    errors += normalize(page.text).length
    failures.push({ page: page.page, reason: '额外或无效页码' })
  }
  const metadataCorrect = !Object.hasOwn(metadata, 'totalPages') || metadata.totalPages === gold.pages.length
  if (!metadataCorrect) failures.push({ reason: `生产页数元数据错误：${metadata.totalPages}，期望${gold.pages.length}` })
  return { fieldAccuracy: ratio(matched, fields), fields, matched,
    characterErrorRate: ratio(errors, characters), pageCountCorrect: actualPages.length === gold.pages.length && metadataCorrect,
    failures }
}

export function validateDataset(samples) {
  const issues = [], ids = new Set()
  for (const sample of samples) {
    if (ids.has(sample.id)) issues.push(`重复案件 ${sample.id}`)
    ids.add(sample.id)
    const claimIds = new Set(), materialIds = new Set(sample.materials.map(m => m.id))
    if (materialIds.size !== sample.materials.length) issues.push(`${sample.id} 材料 ID 重复`)
    for (const claim of sample.claims) {
      if (claimIds.has(claim.id)) issues.push(`${sample.id} 主张 ID 重复 ${claim.id}`)
      claimIds.add(claim.id)
      const targets = new Set()
      for (const expected of claim.expected) {
        const material = sample.materials.find(m => m.id === expected.materialId)
        if (!material || !Number.isInteger(expected.page) || !material.pages[expected.page - 1]
          || !['support', 'contradict', 'context'].includes(expected.relation)) issues.push(`${sample.id}/${claim.id} 标准答案无效`)
        if (targets.has(expected.materialId)) issues.push(`${sample.id}/${claim.id} 标准答案材料重复`)
        targets.add(expected.materialId)
      }
    }
  }
  return issues
}

export function validateManifest(manifest) {
  const issues = [], docs = manifest?.documents
  if (!Array.isArray(docs) || docs.length < 13) return ['附件覆盖不足：至少13个有标注的原件']
  const ids = new Set(), required = ['native_pdf', 'scan_pdf', 'mixed_pdf', 'image_normal', 'image_rotated',
    'image_low_contrast', 'image_blurred', 'corrupt_pdf']
  for (const kind of required) if (!docs.some(d => d.kind === kind)) issues.push(`缺少附件类型 ${kind}`)
  if (!docs.some(d => d.kind === 'mixed_pdf' && d.pages?.some(p => p.mode === 'mixed'))) issues.push('缺少同页文图混合')
  if (!docs.some(d => d.kind === 'mixed_pdf' && d.pages?.some(p => p.mode === 'text') && d.pages?.some(p => p.mode === 'image'))) issues.push('缺少文字扫描交替')
  if (!docs.some(d => d.kind === 'scan_pdf' && d.pages?.length >= 4)) issues.push('缺少四页扫描覆盖边界')
  for (const id of ['table', 'chat']) if (!docs.some(d => d.id === id)) issues.push(`缺少 ${id} 结构附件`)
  for (const doc of docs) {
    if (!doc.id || ids.has(doc.id)) issues.push(`附件ID缺失或重复 ${doc.id}`)
    ids.add(doc.id)
    if (!/^[a-f0-9]{64}$/.test(doc.sha256 ?? '') || typeof doc.file !== 'string') issues.push(`${doc.id} 文件或哈希无效`)
    if (doc.expectFailure) {
      if (doc.kind !== 'corrupt_pdf') issues.push(`${doc.id} 不能把正常附件标记成预期失败`)
      continue
    }
    if (!Array.isArray(doc.pages) || !doc.pages.length) { issues.push(`${doc.id} 无分页标注`); continue }
    for (const page of doc.pages) {
      if (!page.text?.trim() || !Array.isArray(page.fields) || !page.fields.length
        || page.fields.some(f => typeof f !== 'string' || !normalize(f) || !normalize(page.text).includes(normalize(f)))) issues.push(`${doc.id} 原文/字段标注缺失或不匹配`)
    }
    if (!Array.isArray(doc.claims) || !doc.claims.length) issues.push(`${doc.id} 无核验主张`)
    else for (const claim of doc.claims) if (!claim.text || (claim.relation !== null &&
      (!['support', 'contradict', 'context'].includes(claim.relation) || !Number.isInteger(claim.page) || !doc.pages[claim.page - 1]))) issues.push(`${doc.id} 主张标注无效`)
  }
  return issues
}
