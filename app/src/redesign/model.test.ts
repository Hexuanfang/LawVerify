import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildProjects, paragraphElements } from './model.ts'
import { rewriteAnchor } from './rewriteAnchor.ts'

const workspace: any = {
  cases: [
    { id: 'case', name: '真实案件', description: '', createdAt: '2026-11-15' },
  ],
  certificates: [
    { id: 'document', caseId: 'case', title: '起诉状', paragraphs: [], linkageInputKey: 'key' },
  ],
  evidences: [
    {
      id: 'ev',
      caseId: 'case',
      name: '银行流水',
      fileName: 'bank.pdf',
      type: 'pdf',
    },
  ],
  claimUnits: [],
  claimEvidenceMatches: [],
  knowledgeCases: [],
  knowledgeStatutes: [],
}

test('历史单链接能转换，未知评分保留为空', () => {
  const elements = paragraphElements(
    {
      id: 'p',
      text: '已交付五十万元。',
      verified: false,
      link: { evidenceId: 'ev', locator: '第3页', quote: '五十万元' },
    },
    workspace,
    'document',
  )
  assert.equal(elements[0].sources[0].targetId, 'ev')
  assert.equal(elements[0].conf, null)
  assert.equal(elements[0].verdict, 'warn')
})

test('旧证据挂接的匹配分不作为声明核验置信度', () => {
  const paragraph = { id: 'p', text: '已还款。', verified: false,
    links: [{ evidenceId: 'ev', locator: '第1页', quote: '已还款', sentenceIndex: 0, relation: 'support' as const }] }
  const state = { ...workspace,
    claimUnits: [{ id: 'claim', certificateId: 'document', paragraphId: 'p', sentenceIndex: 0 }],
    claimEvidenceMatches: [{ claimUnitId: 'claim', evidenceId: 'ev', relation: 'support', score: 0.88 }],
  }
  const [row] = paragraphElements(paragraph, state, 'document')
  assert.equal(row.conf, null)
  assert.match(row.reason, /待人工核验/u)
})

test('声明仅显示当前核验的置信度，上游变动后隐藏旧分数', () => {
  const paragraph = { id: 'p', text: '已还款。', verified: false }
  const declaration = { id: 'decl', type: 'E-FACT', quote: paragraph.text, verdict: 'pending',
    reason: '已关联出处，待律师核对。', checks: {}, sources: [], conf: 74,
    confidenceCalibration: { version: 'test-rules', calibrationCases: 100, validationCases: 100,
      validationAgreementPercent: 75, basis: '原文可定位，检查无待定项' },
    location: { paragraphId: paragraph.id, start: 0, end: paragraph.text.length } }
  const document = { ...workspace.certificates[0], verification: { inputKey: 'key', declarations: [declaration] } }
  const rows = (certificate: typeof document, current = paragraph) =>
    paragraphElements(current, { ...workspace, certificates: [certificate] }, 'document')
  assert.equal(rows(document)[0].conf, 74)
  assert.equal(rows(document)[0].reason, declaration.reason)
  assert.equal(rows(document, { ...paragraph, text: '未还款。' })[0].conf, null)
  assert.equal(rows({ ...document, verification: { ...document.verification, declarations: [{ ...declaration, conf: undefined }] } })[0].conf, null)
  assert.equal(rows({ ...document, verification: { ...document.verification, declarations: [{ ...declaration, confidenceCalibration: undefined }] } })[0].conf, null)
})

test('同状态的核验待办优先显示身份元素，同类保持正文段序', () => {
  const fields = [
    ['before', 'E-FOCUS', '双方有争议', 'warn'],
    ['core', 'E-FACT', '已经交货', 'warn'],
    ['later', 'E-CLAIM', '请求赔偿', 'warn'],
    ['blocking', 'E-FOCUS', '另有争议', 'fail'],
  ] as const
  const paragraphs = fields.map(([id, , text]) => ({ id, text, verified: false }))
  const declarations = fields.map(([id, type, quote, verdict], paragraphIndex) => ({
    id, type, quote, verdict, checks: {}, sources: [], reason: '',
    location: { paragraphId: id, paragraphIndex, start: 0, end: quote.length },
  }))
  const state = { ...workspace, certificates: [{ ...workspace.certificates[0], docKey: 'qs', paragraphs,
    verification: { inputKey: 'key', declarations } }] }
  assert.deepEqual(buildProjects(state)[0].els.document.map(item => item.id), ['blocking', 'core', 'later', 'before'])
})

test('历史 cx 文书按 proc 的身份元素排序', () => {
  const paragraphs = [{ id: 'optional', text: '已经交货' }, { id: 'identity', text: '地域管辖待确认' }]
  const declarations = paragraphs.map((paragraph, paragraphIndex) => ({ id: paragraph.id, type: paragraphIndex ? 'E-PROC' : 'E-FACT',
    quote: paragraph.text, verdict: 'pending', checks: {}, sources: [], reason: '',
    location: { paragraphId: paragraph.id, paragraphIndex, start: 0, end: paragraph.text.length } }))
  const state = { ...workspace, certificates: [{ ...workspace.certificates[0], docKey: 'cx', paragraphs,
    verification: { inputKey: 'key', declarations } }] }
  assert.deepEqual(buildProjects(state)[0].els.document.map(item => item.id), ['identity', 'optional'])
})

test('确认清单行保留 A3 漏列警告，未确认仍阻断导出', () => {
  const paragraph = { id: 'p', text: '借条', verified: false }
  const declaration = { id: 'd', type: 'E-EVID', verdict: 'pending', quote: paragraph.text, reason: '有卷内证据未列入清单。',
    location: { paragraphId: 'p', start: 0, end: 2 }, checks: { A3: { outcome: 'warn' } },
    sources: [{ tier: 'l1', id: 'ev', name: '借条' }] }
  const state = { ...workspace, certificates: [{ ...workspace.certificates[0], paragraphs: [paragraph], verification: { inputKey: 'key', declarations: [declaration] } }] }
  assert.equal(wordExportReadiness(state, 'document').blocking, 1)
  paragraph.verified = true
  assert.equal(paragraphElements(paragraph, state, 'document')[0].verdict, 'warn')
  assert.equal(wordExportReadiness(state, 'document').allowed, true)
})

test('只给本稿唯一选段定位，重复文本和跨段选区不能用于改写', () => {
  const first = { id: 'p1', text: '前文。借款已交付。后文。', verified: true }
  const second = { id: 'p2', text: '其他正文。', verified: false }
  const certificate = { id: 'current', paragraphs: [first, second] }
  const anchor = rewriteAnchor(certificate, '借款已交付。')
  assert.equal(anchor?.original, first)
  assert.equal(anchor?.start, 3)
  assert.equal(rewriteAnchor(certificate, '后文。\n其他正文。'), undefined)
  assert.equal(rewriteAnchor({ ...certificate, paragraphs: [first, { ...second, text: first.text }] }, '借款已交付。'), undefined)
})

test('人工确认不改变材料关联结果，支持与背景关系分别显示', () => {
  for (const verified of [false, true]) {
    const paragraph = { id: 'p', text: '已还款。', verified,
      links: [{ evidenceId: 'ev', locator: '第1页', quote: '已还款', relation: 'support' as const }] }
    const supported = paragraphElements(paragraph, workspace, 'document')[0]
    assert.equal(supported.verdict, verified ? 'pass' : 'pending')
    assert.equal(supported.verified, verified)
    const context = paragraphElements({ ...paragraph, links: [{ ...paragraph.links[0], relation: 'context' }] }, workspace, 'document')[0]
    assert.equal(context.verdict, 'warn')
    assert.equal(context.verified, verified)
  }
})

test('冲突和缺源保持红灯，人工确认不能掩盖冲突', () => {
  const paragraph = {
    id: 'p',
    text: '已还款。',
    verified: true,
    links: [
      {
        evidenceId: 'ev',
        relation: 'contradict' as const,
        locator: '第2页',
        quote: '未还款',
      },
    ],
  }
  assert.equal(
    paragraphElements(paragraph, workspace, 'document')[0].verdict,
    'fail',
  )
  assert.equal(
    paragraphElements(
      { id: 'q', text: '已还款。', verified: false },
      workspace,
      'document',
    )[0].verdict,
    'miss',
  )
})

test('空工作区返回空列表，同类型多个文书保留真实 ID', () => {
  assert.deepEqual(buildProjects({ ...workspace, cases: [] }), [])
  const projects = buildProjects({
    ...workspace,
    certificates: [
      ...workspace.certificates,
      { id: 'second', caseId: 'case', title: '起诉状', paragraphs: [] },
    ],
  })
  assert.deepEqual(projects[0].docs, ['document', 'second'])
  assert.equal(projects[0].docNames.second, '起诉状')
})

test('构建案件列表时，全局材料、主张和匹配记录只需各扫描一次', () => {
  const cases = Array.from({ length: 10 }, (_, index) => ({ id: `case-${index}`, name: `案件 ${index}` }))
  const scanCounts = { evidences: 0, claimUnits: 0, claimEvidenceMatches: 0 }
  const measure = <T>(records: T[], name: keyof typeof scanCounts) => new Proxy(records, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/u.test(key)) scanCounts[name]++
      return Reflect.get(target, key, receiver)
    },
  })
  const certificates = cases.map(({ id: caseId }) => ({
    id: `${caseId}-doc`, caseId, title: '起诉状', linkageInputKey: 'key',
    paragraphs: ['first', 'second'].map(position => ({ id: `${caseId}-${position}`, text: '已付货款。', verified: true,
      links: [{ evidenceId: `${caseId}-evidence`, sentenceIndex: 0 }] })),
  }))
  const evidences = cases.map(({ id: caseId }) => ({ ...workspace.evidences[0], id: `${caseId}-evidence`, caseId }))
  const claimUnits = certificates.flatMap(doc => doc.paragraphs.map(paragraph => ({
    id: `${paragraph.id}-claim`, paragraphId: paragraph.id, certificateId: doc.id, sentenceIndex: 0,
  })))
  const matches = claimUnits.map(claim => ({ claimUnitId: claim.id, evidenceId: claim.certificateId.replace(/-doc$/u, '-evidence'),
    relation: claim.paragraphId.endsWith('-first') ? 'support' : 'contradict' }))
  const projects = buildProjects({ ...workspace, cases, certificates, evidences: measure(evidences, 'evidences'),
    claimUnits: measure(claimUnits, 'claimUnits'), claimEvidenceMatches: measure(matches, 'claimEvidenceMatches') })

  const last = projects.at(-1)!
  assert.deepEqual(last.mats.map(item => item.id), ['case-9-evidence'])
  assert.deepEqual(last.els['case-9-doc'].map(item => [item.paragraphId, item.verdict]), [['case-9-second', 'fail'], ['case-9-first', 'pass']])
  assert.deepEqual(scanCounts, { evidences: evidences.length, claimUnits: claimUnits.length, claimEvidenceMatches: matches.length })
})

test('部分匹配不能隐藏同段缺源声明', () => {
  const paragraph = {
    id: 'p',
    text: '已交付借款。另有房产两套。',
    verified: true,
    links: [
      {
        evidenceId: 'ev',
        locator: '第1页',
        quote: '借款',
        sentenceIndex: 0,
        sentenceText: '已交付借款。',
      },
    ],
  }
  const elements = paragraphElements(paragraph, workspace, 'document')
  assert.equal(elements.length, 2)
  assert.equal(elements[1].quote, '另有房产两套。')
  assert.equal(elements[1].verdict, 'miss')
})

test('重复句子使用各自范围定位，来源中的旧文字不覆盖真实正文', () => {
  const paragraph = {
    id: 'p',
    text: '已还款。已还款。',
    verified: false,
    links: [
      {
        evidenceId: 'ev',
        locator: '第1页',
        quote: '',
        sentenceIndex: 1,
        sentenceText: '旧文案。',
      },
    ],
  }
  const elements = paragraphElements(paragraph, workspace, 'document')
  assert.equal(elements[1].quote, '已还款。')
  assert.equal(elements[1].start, 4)
  assert.equal(elements[1].end, 8)
})

// 新版正式切换前的审阅与正文保存规则。
import { reviewReadiness, reanchorParagraph, wordExportReadiness } from './workflow.ts'

test('文书导出和案件审阅各只扫描一次文书所属的材料', () => {
  const paragraphs = Array.from({ length: 12 }, (_, index) => ({
    id: `p${index}`, text: '已交付。', verified: true,
    links: [{ evidenceId: 'ev', locator: '第1页', quote: '已交付。', relation: 'support' }],
  }))
  const evidences = [...workspace.evidences]
  const filter = evidences.filter.bind(evidences)
  let scans = 0
  Object.defineProperty(evidences, 'filter', { value: (predicate: Parameters<typeof filter>[0]) => {
    scans++
    return filter(predicate)
  } })
  const state = { ...workspace, evidences, certificates: [{ ...workspace.certificates[0], paragraphs }] }
  assert.equal(wordExportReadiness(state, 'document').allowed, true)
  assert.equal(scans, 1)
  scans = 0
  assert.deepEqual(reviewReadiness(state, 'case'), { total: 12, unreviewed: 0, red: 0, ready: true })
  assert.equal(scans, 1)
})

test('正文 Word 阻断空稿、过期、历史已确认但未重核、红灯、缺源及待人工核验的支持项', () => {
  const link = { evidenceId: 'ev', relation: 'support' as const }
  const paragraph = { id: 'p', text: '已还款。', verified: true, links: [link] }
  const saved = { ...workspace.certificates[0], linkageInputKey: 'key', paragraphs: [paragraph] }
  const gate = (patch: object) => wordExportReadiness({ ...workspace, certificates: [{ ...saved, ...patch }] }, saved.id)
  assert.equal(gate({}).allowed, true)
  assert.equal(gate({ paragraphs: [{ ...paragraph, note: '人工核对完成' }] }).elements[0].verdict, 'note')
  assert.equal(gate({ paragraphs: [{ ...paragraph, note: '人工核对完成' }] }).allowed, true)
  assert.equal(gate({ paragraphs: [{ ...paragraph, verified: false, links: [{ ...link, relation: 'context' }] }] }).allowed, true)
  assert.equal(gate({ paragraphs: [{ ...paragraph, links: [{ ...link, relation: 'contradict' }] }] }).allowed, false)
  assert.equal(gate({ paragraphs: [{ ...paragraph, links: [] }] }).allowed, false)
  assert.equal(gate({ paragraphs: [{ ...paragraph, verified: false }] }).allowed, false)
  assert.equal(gate({ paragraphs: [{ ...paragraph, text: ' ' }] }).allowed, false)
  assert.equal(gate({ linkageInputKey: undefined }).allowed, false)
  assert.equal(gate({ linkageStale: true }).allowed, false)
})

test('刚写入的草稿即使具备支持链接仍是待核验，删除的来源不再显示为 L1', () => {
  const paragraph = { id: 'p', text: '已还款。', verified: true, links: [{ evidenceId: 'ev', locator: '第1页', quote: '已还款', relation: 'support' as const }] }
  const generated = { ...paragraph, aiOrigin: 'draft' as const }
  const draft = { ...workspace, certificates: [{ ...workspace.certificates[0], linkageInputKey: undefined, paragraphs: [generated] },
    { ...workspace.certificates[0], id: 'ready', paragraphs: [paragraph] }] }
  assert.equal(wordExportReadiness(draft, 'document').elements[0].verdict, 'pending')
  assert.equal(wordExportReadiness(draft, 'document').allowed, false)
  assert.equal(wordExportReadiness(draft, 'ready').allowed, true)
  const [deleted] = paragraphElements(paragraph, { ...workspace, evidences: [] }, 'document')
  assert.equal(deleted.src, 'l0')
  assert.deepEqual(deleted.sources, [])
})

test('没有文书或空文书不能标记案件完成', () => {
  assert.equal(reviewReadiness({ ...workspace, certificates: [] }, 'case').ready, false)
  assert.equal(reviewReadiness(workspace, 'case').ready, false)
})

test('必须审阅所有文书段落，红灯不能因人工标记而放行', () => {
  const paragraph = { id: 'p', text: '已还款。', verified: false, links: [{ evidenceId: 'ev', locator: '第1页', quote: '已还款' }] }
  const state = { ...workspace, certificates: [{ ...workspace.certificates[0], paragraphs: [paragraph] }] }
  assert.equal(reviewReadiness(state, 'case').unreviewed, 1)
  paragraph.verified = true
  assert.equal(reviewReadiness(state, 'case').ready, true)
  paragraph.links[0] = { ...paragraph.links[0], relation: 'contradict' } as any
  assert.equal(reviewReadiness(state, 'case').ready, false)
})

test('整段修改仅保留可精确重定位的未改句引用，取消原审阅状态', () => {
  const paragraph = { id: 'p', text: '第一句。第二句。', verified: true, links: [
    { evidenceId: 'ev', locator: '第1页', quote: '甲', sentenceIndex: 0, sentenceText: '第一句。' },
    { evidenceId: 'ev', locator: '第2页', quote: '乙', sentenceIndex: 1, sentenceText: '第二句。' },
  ] }
  const patch = reanchorParagraph(paragraph, '新增内容。第一句。修改末句。', '<p>新增内容。第一句。修改末句。</p>')
  assert.equal(patch.verified, false)
  assert.equal(patch.links?.length, 1)
  assert.equal(patch.links?.[0].sentenceIndex, 1)
  assert.equal(patch.links?.[0].locator, '第1页')
})

test('仅改格式保留原引用与审阅，重复句定位不明确时不误挂引用', () => {
  const paragraph = { id: 'p', text: '重复。重复。', verified: true, links: [{ evidenceId: 'ev', locator: '末句', quote: '乙', sentenceIndex: 1 }] }
  assert.equal(reanchorParagraph(paragraph, paragraph.text, '<p><b>重复。重复。</b></p>').verified, true)
  assert.equal(reanchorParagraph(paragraph, '新增。重复。重复。', '').links?.length, 0)
})
test('人工移除引用后旧声明匹配不再误报冲突，未人工更正的有效冲突仍保留', () => {
  const state = { ...workspace, claimUnits: [{ id: 'claim', certificateId: 'document', paragraphId: 'p', sentenceIndex: 0, sourceParagraphText: '借款已还。' }],
    claimEvidenceMatches: [{ claimUnitId: 'claim', evidenceId: 'old', relation: 'contradict', score: 1 }] }
  const p = { id: 'p', text: '借款已还。', verified: false, links: [{ evidenceId: 'ev', locator: '第1页', quote: '借款已还', sentenceIndex: 0, relation: 'support' as const }] }
  assert.equal(paragraphElements(p, state as any, 'document')[0].verdict, 'pending')
  state.claimEvidenceMatches[0].evidenceId = 'ev'
  assert.equal(paragraphElements(p, state as any, 'document')[0].verdict, 'fail')
  p.links[0] = { ...p.links[0], reason: '人工维护引用关系，请重新审阅。' } as any
  assert.equal(paragraphElements(p, state as any, 'document')[0].verdict, 'warn')
})
test('空白排版段落不计入审阅进度，只有空白的文书不能完成', () => {
  const state = { ...workspace, certificates: [{ id:'empty',caseId:'case',paragraphs:[{id:'space',text:'   ',verified:true}]}] } as any
  assert.equal(reviewReadiness(state,'case').ready,false)
  assert.equal(reviewReadiness(state,'case').total,0)
})
