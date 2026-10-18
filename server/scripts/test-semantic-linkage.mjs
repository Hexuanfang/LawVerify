import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import * as policy from '../src/intelligence/linkage-policy.ts'
import { buildClaimUnits, buildClaimEvidenceMatches, buildEvidenceFragments } from '../src/intelligence/evidence-matching.ts'
import { createDocumentTaskQueue } from '../../app/src/document-task-queue.ts'

// Exercise the actual service functions without loading databases, accounts or API keys.
function loadFunctions(file, names, mocks = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const snippets = []
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) snippets.push(node.getText(ast).replace(/^export\s+/, ''))
    if (ts.isVariableDeclaration(node) && names.includes(node.name?.text)) snippets.push(`const ${node.getText(ast)};`)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const context = vm.createContext({ ...policy, ...mocks })
  vm.runInContext(ts.transpileModule(
    snippets.join('\n') + '\nthis.exports={' + names.join(',') + '};',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText, context)
  return context.exports
}

const serviceFile = '../src/service.ts'

test('文书失焦保存完成后才启动联动，结果提交保持顺序', async () => {
  const queue = createDocumentTaskQueue()
  const events = []
  let finishSave
  const gate = new Promise(resolve => { finishSave = resolve })
  const save = queue.run(async () => {
    events.push('save-start')
    await gate
    events.push('save-finish')
  })
  const link = queue.run(async () => { events.push('link') })
  await Promise.resolve()
  assert.deepEqual(events, ['save-start'])
  finishSave()
  await Promise.all([save, link])
  assert.deepEqual(events, ['save-start', 'save-finish', 'link'])
})

test('保存失败阻止依赖旧正文的联动，恢复后可以再次保存', async () => {
  const queue = createDocumentTaskQueue()
  let linked = false
  const save = queue.run(async () => { throw new Error('save failed') })
  const link = queue.run(async () => { linked = true })
  await assert.rejects(save, /save failed/)
  await assert.rejects(link, /save failed/)
  assert.equal(linked, false)
  queue.recover()
  assert.equal(await queue.run(async () => 'saved'), 'saved')
})

test('真实界面处理函数在编辑保存后调用联动，并拦截重复点击', async () => {
  const events = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const certificate = { id: 'c', caseId: 'case', paragraphs: [{ id: 'p' }] }
  const noop = () => {}
  const handlers = loadFunctions('../../app/src/App.tsx', [
    'handleUpdateParagraphById', 'handleAutoLinkCertificate',
  ], {
    activeCertificate: certificate, activeParagraph: { id: 'p' }, selectedEvidenceIds: [],
    previewEvidence: null,
    documentTaskQueueRef: { current: createDocumentTaskQueue() },
    documentAnalysisRunningRef: { current: false },
    api: {
      updateParagraph: async () => { events.push('save'); await gate; return { workspace: {} } },
      autoLinkCertificate: async () => {
        events.push('link')
        return { workspace: {}, linkedParagraphCount: 0, evidenceLinkCount: 0, statuteReferenceCount: 0, caseReferenceCount: 0 }
      },
    },
    runMutation: async task => { await task(); return true },
    applyWorkspace: noop, setAutoLinkFeedback: noop, setLockedPreviewEvidenceId: noop,
    setAutoLinkingCertificateId: noop, openCaseCenter: noop, setPreviewPanelMode: noop,
    revealInsightPanel: noop, handleOpenEvidenceLinking: noop,
  })
  const save = handlers.handleUpdateParagraphById('p', { text: 'edited' })
  const link = handlers.handleAutoLinkCertificate()
  await handlers.handleAutoLinkCertificate()
  await Promise.resolve()
  assert.deepEqual(events, ['save'])
  release()
  await Promise.all([save, link])
  assert.deepEqual(events, ['save', 'link'])
})

test('只修改备注或格式不重新识别法条，也不删除已有自动法条', async () => {
  const paragraph = {
    id: 'p', text: '原文', richText: '<p>原文</p>',
    references: [{ id: 'r', note: 'system:auto-statute-detected' }],
  }
  let saved
  const workspace = { certificates: [{ id: 'c', paragraphs: [paragraph] }] }
  const { updateParagraph } = loadFunctions(serviceFile, ['updateParagraph'], {
    readWorkspace: async () => saved ?? workspace,
    writeWorkspace: async state => { saved = state },
    normalizeParagraph: p => p,
    attachAutoStatuteReferencesToParagraph: () => { throw new Error('must not retrieve') },
  })
  await updateParagraph('c', 'p', { note: '已核验', richText: '<p><strong>原文</strong></p>' })
  assert.equal(saved.certificates[0].paragraphs[0].references[0].id, 'r')
  assert.equal(saved.certificates[0].paragraphs[0].note, '已核验')
})

const automatic = 'system:auto-evidence-linked'
const autoStatute = 'system:auto-statute-detected'
const autoCase = 'system:auto-case-detected'
const fact = '甲方于2026年10月1日支付代理费5000元。'
const conflict = '双方对2026年10月1日是否已支付代理费5000元存在争议。'
const evidence = (id, number, text, role = 'source_evidence') => ({
  id, number, name: '材料', fileName: `${id}.txt`, caseId: 'case-1',
  type: 'text', ocrText: text, anchorHint: '原件全文', materialRole: role,
})
const focusFor = (text, kind = 'fact') => policy.normalizeSentenceLinkageFocus(text, policy.getLinkageSentences(text).map(s => ({
  ...s, kind, priority: 'high', reason: '核验付款事实及责任争议',
  evidenceNeeded: true, statuteNeeded: true, caseNeeded: true,
})))
const intentFor = (sentenceIndex, sentenceGroup, evidenceNumber, quoteHint, relation = 'support') => ({
  sentenceIndex, sentenceGroup, evidenceNumber, quoteHint, relation, reason: '核验对应付款记录',
})
const pipeline = loadFunctions(serviceFile, [
  'attachAutoEvidenceLinksToCertificateWithLlm',
  'attachAutoStatuteReferencesToCertificateWithLlm',
  'attachAutoCaseReferencesToCertificateWithLlm',
  'inferParagraphLinksFromEvidenceNumbers',
], {
  AUTO_EVIDENCE_LINK_NOTE: automatic,
  AUTO_STATUTE_REFERENCE_NOTE: autoStatute,
  AUTO_CASE_REFERENCE_NOTE: autoCase,
  getParagraphLinks: p => p.links ?? (p.link ? [p.link] : []),
  getLatestEvidenceInsight: (workspace, id) => {
    const item = workspace.evidences.find(e => e.id === id)
    return item ? { materialRole: item.materialRole, status: 'ready', summary: item.ocrText, keyFacts: [] } : null
  },
  getEvidenceFragmentsForEvidence: (workspace, id) => [{ text: workspace.evidences.find(e => e.id === id)?.ocrText ?? '' }],
  getMeaningfulEvidenceText: text => text ?? '',
  findBestEvidenceFragmentForParagraph: () => ({ locator: '原件全文' }),
  createEvidenceLink: (_, e, locator, quote, anchor) => ({ evidenceId: e.id, locator, quote, ...anchor }),
  normalizeParagraph: p => p,
  getQuote: text => text.slice(0, 120),
  recommendStatuteBindingsFromWorkspace: () => { throw new Error('Skipped sentences must not retrieve statutes') },
  recommendKnowledgeCasesFromWorkspace: () => { throw new Error('Skipped sentences must not retrieve cases') },
})

test('截图中的标题、姓名、证件编号、服务方和信用代码不自动关联', () => {
  for (const text of ['委托代理合同', '甲方（委托方）：张长松', '身份号码：131082197404158514', '乙方（服务方）：北京市曙鹏律师事务所', '统一社会信用代码：311100005514149202']) {
    const [focus] = focusFor(text, 'dispute')
    assert.equal(focus.priority, 'skip', text)
    for (const channel of ['evidence', 'statute', 'case']) assert.equal(policy.getEligibleLinkageAnchor(text, [focus], { sentenceIndex: 0 }, channel), null)
  }
})

test('身份冒用与主体资格真的存在争议时允许实质核验', () => {
  const text = '甲方姓名：张长松，但合同签名与身份证记载不一致，存在冒用争议。'
  const [focus] = focusFor(text, 'dispute')
  assert.equal(focus.priority, 'high')
  assert.ok(policy.getEligibleLinkageAnchor(text, [focus], { sentenceIndex: 0 }, 'evidence'))
})

test('普通付款事实不因为模型过度建议而挂法律和案例', () => {
  const [focus] = focusFor(fact)
  assert.equal(focus.evidenceNeeded, true)
  assert.equal(focus.statuteNeeded, false)
  assert.equal(focus.caseNeeded, false)
})

test('常识性内容由语义判断跳过，空判断和非法布尔值不自动关联', () => {
  const text = '当事人应遵循诚实信用原则。'
  const [focus] = policy.normalizeSentenceLinkageFocus(text, [{
    sentenceIndex: 0, kind: 'background', priority: 'skip', reason: '常识',
    evidenceNeeded: true, statuteNeeded: true, caseNeeded: true,
  }])
  assert.equal(focus.priority, 'skip')
  assert.equal(policy.normalizeSentenceLinkageFocus(fact, [])[0].evidenceNeeded, false)
  assert.equal(policy.normalizeSentenceLinkageFocus(fact, [{
    sentenceIndex: 0, kind: 'fact', priority: 'high', reason: '付款', evidenceNeeded: 'true',
  }])[0].evidenceNeeded, false)
})

test('句子锚点不匹配时不得兜底关联第一句', () => {
  const text = fact + conflict
  assert.equal(policy.resolveExactLinkageSentence(text, { sentenceText: '案件摘要' }), null)
  assert.equal(policy.resolveExactLinkageSentence(text, { sentenceIndex: 0, sentenceText: conflict }), null)
  assert.equal(policy.resolveExactLinkageSentence(text, { sentenceIndex: 99 }), null)
  assert.equal(policy.resolveExactLinkageSentence(fact + fact, { sentenceText: fact }), null)
  assert.equal(policy.resolveExactLinkageSentence(fact + fact, { sentenceIndex: 1, sentenceText: fact }).sentenceIndex, 1)
})

test('真实摘录可验证，只有文件名、编号或虚构内容不能证明事实', () => {
  assert.equal(policy.isGroundedLinkageQuote('收到代理费5000元', ['银行凭证：收到代理费5000元']), true)
  assert.equal(policy.isGroundedLinkageQuote('收到代理费9000元', ['收到代理费5000元']), false)
  assert.equal(policy.isGroundedLinkageQuote('5000元', ['收到代理费5000元']), false)
})

test('证件与底稿按正文识别，底稿强制保留独立证明限制', () => {
  assert.equal(policy.inferMaterialRoleFromContent('中华人民共和国居民身份证'), 'identity')
  assert.equal(policy.inferMaterialRoleFromContent('律师工作底稿：当事人称已付款'), 'working_draft')
  const normalized = policy.normalizeMaterialUnderstanding({ materialRole: 'working_draft', proofPurposes: ['当事人主张'], disputedPoints: ['付款状态待核实'] })
  assert.match(normalized.proofLimitations.join(''), /不能独立证明/)
  assert.deepEqual(normalized.disputedPoints, ['付款状态待核实'])
})

test('同一证据可挂不同关键句，去重不能按整段证据ID删除', () => {
  const text = fact + conflict
  const e = evidence('e1', 'E01', '收到代理费5000元，交易日期2026年10月1日。')
  const workspace = { evidences: [e] }
  const certificate = { paragraphs: [{ id: 'p1', text, links: [] }] }
  const analyses = new Map([['p1', { sentenceFocus: focusFor(text, 'dispute'), evidenceLinks: [
    intentFor(0, fact, 'E01', '收到代理费5000元'),
    intentFor(1, conflict, 'E01', '收到代理费5000元', 'contradict'),
    intentFor(1, conflict, 'E01', '收到代理费5000元', 'contradict'),
  ] }]])
  const links = pipeline.attachAutoEvidenceLinksToCertificateWithLlm(workspace, certificate, [e], analyses).paragraphs[0].links
  assert.equal(links.length, 2)
  assert.equal(links[1].sentenceIndex, 1)
  assert.equal(links[1].relation, 'contradict')
})

test('重跑清理旧自动误关联并保留手工绑定', () => {
  const paragraph = { id: 'p1', text: '甲方：张长松', links: [
    { evidenceId: 'manual', note: '律师手工绑定', sentenceIndex: 0 },
    { evidenceId: 'old', note: automatic, sentenceIndex: 0 },
  ] }
  const result = pipeline.attachAutoEvidenceLinksToCertificateWithLlm({ evidences: [] }, { paragraphs: [paragraph] }, [], new Map())
  assert.equal(result.paragraphs[0].links.length, 1)
  assert.equal(result.paragraphs[0].links[0].evidenceId, 'manual')
})

test('底稿不会以支持证据身份独立证明付款', () => {
  const e = evidence('draft', 'E02', '律师工作底稿：当事人称收到代理费5000元。', 'working_draft')
  const analyses = new Map([['p1', { sentenceFocus: focusFor(fact), evidenceLinks: [intentFor(0, fact, 'E02', '当事人称收到代理费5000元')] }]])
  const result = pipeline.attachAutoEvidenceLinksToCertificateWithLlm({ evidences: [e] }, { paragraphs: [{ id: 'p1', text: fact, links: [] }] }, [e], analyses)
  assert.equal(result.paragraphs[0].links[0].relation, 'context')
})

test('证件不能挂到付款事实，虚构摘录不能挂到任何事实', () => {
  for (const e of [evidence('identity', 'E03', '居民身份证，当事人称收到代理费5000元', 'identity'), evidence('real', 'E03', '材料内容：未出现任何付款记录')]) {
    const analyses = new Map([['p1', { sentenceFocus: focusFor(fact), evidenceLinks: [intentFor(0, fact, 'E03', '当事人称收到代理费5000元')] }]])
    const result = pipeline.attachAutoEvidenceLinksToCertificateWithLlm({ evidences: [e] }, { paragraphs: [{ id: 'p1', text: fact, links: [] }] }, [e], analyses)
    assert.equal(result.paragraphs[0].links.length, 0)
  }
})

test('整段摘要、法律问题和类案主题不会绕过具体句子的筛选', async () => {
  const paragraph = { id: 'p1', text: '统一社会信用代码：311100005514149202', references: [
    { type: 'statute', note: autoStatute, targetId: 'old-law' },
    { type: 'case', note: autoCase, targetId: 'old-case' },
    { type: 'case', note: '手工引用', targetId: 'manual-case' },
  ] }
  const certificate = { caseId: 'case-1', paragraphs: [paragraph] }
  const analyses = new Map([['p1', {
    sentenceFocus: focusFor(paragraph.text, 'dispute'),
    legalIssues: ['合同效力'], caseSearchTopics: ['合同法案例'], paragraphSummary: '身份信息',
    statuteIntents: [{ sentenceIndex: 0, sentenceGroup: paragraph.text, reason: '泛化', query: '合同法' }],
    caseIntents: [{ sentenceIndex: 0, sentenceGroup: paragraph.text, reason: '泛化', query: '合同法' }],
  }]])
  const statutes = await pipeline.attachAutoStatuteReferencesToCertificateWithLlm({}, certificate, analyses)
  const cases = await pipeline.attachAutoCaseReferencesToCertificateWithLlm({ cases: [] }, statutes, analyses)
  assert.equal(cases.paragraphs[0].references.length, 1)
  assert.equal(cases.paragraphs[0].references[0].targetId, 'manual-case')
})

test('法律适配核验拒绝低置信度、未适用、重复及虚构ID', async () => {
  const { selectRelevantLegalLinkageCandidates } = loadFunctions(serviceFile, ['selectRelevantLegalLinkageCandidates'], {
    createChatCompletion: async () => ({ content: JSON.stringify({ selections: [
      { id: 'correct', applicable: true, confidence: 0.9, reason: '处理授权争议' },
      { id: 'correct', applicable: true, confidence: 0.9, reason: '重复' },
      { id: 'unrelated', applicable: false, confidence: 0.99, reason: '不同争点' },
      { id: 'weak', applicable: true, confidence: 0.5, reason: '仅案由相似' },
      { id: 'invented', applicable: true, confidence: 1, reason: '不存在' },
    ] }) }),
    tryParseLlmJsonObject: JSON.parse,
  })
  const selections = await selectRelevantLegalLinkageCandidates('case', conflict, '付款争议', ['correct', 'unrelated', 'weak'].map(id => ({ id, title: id, content: '裁判理由' })))
  assert.equal(selections.length, 1)
  assert.equal(selections[0].id, 'correct')
})

test('文书生成无证据编号时不再按段落序号任意配证据', () => {
  const e = evidence('e1', 'E01', '收到代理费5000元')
  assert.equal(pipeline.inferParagraphLinksFromEvidenceNumbers({ text: fact, evidenceNumbers: [] }, [e], 0).length, 0)
  assert.equal(pipeline.inferParagraphLinksFromEvidenceNumbers({ text: '委托代理合同', evidenceNumbers: ['E01'] }, [e], 0).length, 0)
  const links = pipeline.inferParagraphLinksFromEvidenceNumbers({ text: fact, evidenceNumbers: ['E01'] }, [e], 0)
  assert.equal(links[0].sentenceText, fact)
  assert.equal(pipeline.inferParagraphLinksFromEvidenceNumbers({ text: fact + conflict, evidenceNumbers: ['E01'] }, [e], 0).length, 0)
})

test('存储归一化保留句子锚点、矛盾类型和关联理由', () => {
  const { normalizeParagraphLinks } = loadFunctions('../src/store.ts', ['normalizeParagraphLinks'], {
    buildParagraphRichText: () => '<p></p>', normalizeParagraphReferences: refs => refs ?? [],
  })
  const link = { evidenceId: 'e1', sentenceIndex: 2, sentenceText: conflict, relation: 'contradict', reason: '付款记录矛盾', quote: '未收到付款', locator: '第1页' }
  const paragraph = normalizeParagraphLinks({ id: 'p1', text: conflict, links: [link] })
  assert.equal(paragraph.links[0].sentenceIndex, 2)
  assert.equal(paragraph.links[0].relation, 'contradict')
  assert.equal(paragraph.links[0].reason, '付款记录矛盾')
})

test('句级匹配不会把一条关联扩散至同段所有句子，保留矛盾关系', () => {
  const e = evidence('e1', 'E01', '未收到代理费5000元。')
  const certificate = { id: 'c1', caseId: 'case-1', paragraphs: [{
    id: 'p1', text: fact + conflict, verified: false,
    links: [{ evidenceId: e.id, sentenceIndex: 1, sentenceText: conflict, relation: 'contradict', reason: '付款记录冲突', quote: '未收到代理费5000元', locator: '原件全文', note: automatic }],
    linkageFocus: focusFor(fact + conflict, 'dispute'),
  }] }
  const claims = buildClaimUnits([certificate])
  assert.equal(claims[0].status, 'unmatched')
  assert.equal(claims[1].status, 'linked')
  const matches = buildClaimEvidenceMatches([certificate], claims, buildEvidenceFragments([e])).filter(item => item.source === 'model')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].claimUnitId, claims[1].id)
  assert.equal(matches[0].relation, 'contradict')
})

test('普通信息整批跳过模型调用；语义判断无实质价值时不继续做关联', async () => {
  let calls = 0
  const { analyzeCertificateAutoLinksWithLlm } = loadFunctions(serviceFile, ['analyzeCertificateAutoLinksWithLlm'], {
    isLlmConfigured: () => true,
    buildEvidenceSemanticScoreMap: async () => new Map(),
    chunkItems: items => items.length ? [items] : [],
    buildParagraphAutoLinkPayload: (_, __, chunk) => chunk.map(p => ({ paragraphId: p.id, text: p.text, sentenceGroups: policy.getLinkageSentences(p.text) })),
    requestLinkageParagraphBatch: async () => {
      calls++
      return { paragraphs: [{
        paragraphId: 'general', sentenceFocus: [{ sentenceIndex: 0, kind: 'background', priority: 'skip', reason: '常识' }],
      }] }
    },
    tryParseLlmJsonObject: JSON.parse,
    normalizeAutoLinkSignalList: () => [],
  })
  const workspace = { cases: [] }
  const normal = await analyzeCertificateAutoLinksWithLlm(workspace, { paragraphs: [{ id: 'identity', text: '甲方：张长松' }] }, [], null)
  assert.equal(calls, 0)
  assert.equal(normal.get('identity').sentenceFocus[0].priority, 'skip')
  const general = await analyzeCertificateAutoLinksWithLlm(workspace, { paragraphs: [{ id: 'general', text: '当事人应遵循诚实信用原则。' }] }, [], null)
  assert.equal(calls, 1)
  assert.equal(general.get('general').caseIntents.length, 0)
})

test('材料理解结构化解析保留证明用途、边界和矛盾点', () => {
  const { normalizeEvidenceInsightDraftFromParsed } = loadFunctions(serviceFile, ['normalizeEvidenceInsightDraftFromParsed'], {
    uniqueStrings: items => [...new Set(items)],
  })
  const fallback = {
    summary: '底稿', keyFacts: [], entities: [], timelineEvents: [], amounts: [], positions: [], issues: [],
    sourceFragmentIds: [], confidence: 0.7,
  }
  const result = normalizeEvidenceInsightDraftFromParsed({
    materialRole: 'working_draft', proofPurposes: ['当事人待核验主张'],
    proofLimitations: ['尚无付款原件'], disputedPoints: ['5000元付款状态矛盾'],
  }, fallback)
  assert.equal(result.materialRole, 'working_draft')
  assert.equal(result.proofPurposes[0], '当事人待核验主张')
  assert.equal(result.disputedPoints[0], '5000元付款状态矛盾')
  assert.match(result.proofLimitations.join(''), /尚无付款原件/)
  assert.match(result.proofLimitations.join(''), /不能独立证明/)
})

test('法条与案例只挂到通过适配的争议句，不回填第一句', async () => {
  const legal = loadFunctions(serviceFile, [
    'attachAutoStatuteReferencesToCertificateWithLlm', 'attachAutoCaseReferencesToCertificateWithLlm',
  ], {
    AUTO_STATUTE_REFERENCE_NOTE: autoStatute, AUTO_CASE_REFERENCE_NOTE: autoCase,
    normalizeParagraph: p => p,
    recommendStatuteBindingsFromWorkspace: async () => [{
      binding: { document: { title: '民法典' }, article: { id: 'law-1', articleNumber: '第五百零九条', content: '当事人应当按照约定全面履行自己的义务。' } },
    }],
    isPlaceholderStatuteContent: () => false,
    selectRelevantLegalLinkageCandidates: async (channel, _, __, candidates) => [{ id: candidates[0].id, reason: `${channel}规则适配履行争议` }],
    buildStatuteReference: (_, article, anchor) => ({ type: 'statute', targetId: article.id, ...anchor }),
    recommendKnowledgeCasesFromWorkspace: async () => ({ items: [{
      id: 'case-1', title: '付款履行争议', issueSummary: '付款履行争议', excerpts: [{ id: 'excerpt-1', content: '裁判理由原文' }],
    }] }),
    mergeKnowledgeCasesIntoWorkspace: (_, items) => items,
    buildCaseReference: (_, excerpt, anchor) => ({ type: 'case', targetId: excerpt.id, ...anchor }),
  })
  const text = fact + conflict
  const analyses = new Map([['p1', {
    sentenceFocus: focusFor(text, 'dispute'),
    statuteIntents: [{ sentenceIndex: 1, sentenceGroup: conflict, reason: '履行争议', query: '履行义务' }],
    caseIntents: [{ sentenceIndex: 1, sentenceGroup: conflict, reason: '履行争议', query: '付款证明责任' }],
  }]])
  const certificate = { paragraphs: [{ id: 'p1', text, references: [] }] }
  const withLaw = await legal.attachAutoStatuteReferencesToCertificateWithLlm({}, certificate, analyses)
  const result = await legal.attachAutoCaseReferencesToCertificateWithLlm({ cases: [] }, withLaw, analyses)
  assert.equal(result.paragraphs[0].references.length, 2)
  for (const reference of result.paragraphs[0].references) {
    assert.equal(reference.sentenceIndex, 1)
    assert.equal(reference.sentenceText, conflict)
    assert.match(reference.reason, /适配/)
  }
})

const responseParser = loadFunctions('../src/intelligence/linkage-response.ts', [
  'hasStageFields', 'parseLinkageParagraphResponse',
])

test('联动解析支持标准封装、数组、单段对象和编码后的JSON', () => {
  const paragraph = { paragraphId: 'p1', sentenceFocus: [{ sentenceIndex: 0, kind: 'fact' }] }
  for (const value of [{ paragraphs: [paragraph] }, [paragraph], paragraph, { data: { paragraphs: [paragraph] } }, JSON.stringify({ paragraphs: [paragraph] })]) {
    const parsed = responseParser.parseLinkageParagraphResponse(JSON.stringify(value), ['p1'], 'overview')
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].paragraphId, 'p1')
  }
})

test('截断的外层JSON恢复完整段落，不误取内层句子判断对象', () => {
  const paragraph = { paragraphId: 'p1', sentenceFocus: [{ sentenceIndex: 0, kind: 'fact', reason: '原文包含“{付款}”和转义引号"' }] }
  const raw = '{"paragraphs":[' + JSON.stringify(paragraph) + ',{"paragraphId":"p2","sentenceFocus":[{"sentenceIndex":0,"reason":"未完成'
  const parsed = responseParser.parseLinkageParagraphResponse(raw, ['p1', 'p2'], 'overview')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].paragraphId, 'p1')
})

test('联动解析拒绝虚构段落ID和错误阶段数据', () => {
  assert.equal(responseParser.parseLinkageParagraphResponse('{"paragraphId":"invented","sentenceFocus":[]}', ['p1'], 'overview').length, 0)
  assert.equal(responseParser.parseLinkageParagraphResponse('{"paragraphId":"p1","sentenceIndex":0,"kind":"fact"}', ['p1'], 'overview').length, 0)
  assert.equal(responseParser.parseLinkageParagraphResponse('{"paragraphId":"p1","sentenceFocus":[]}', ['p1'], 'links').length, 0)
})

test('只重试截断或遗漏段落，不重新请求已经完成的段落', async () => {
  const calls = []
  const paragraph = { paragraphId: 'p1', sentenceFocus: [] }
  const adapter = loadFunctions('../src/intelligence/linkage-response.ts', [
    'hasStageFields', 'parseLinkageParagraphResponse', 'requestLinkageParagraphBatch',
  ], {
    createChatCompletion: async options => {
      calls.push(options)
      return { content: calls.length === 1
        ? '{"paragraphs":[' + JSON.stringify(paragraph) + ',{"paragraphId":"p2","sentenceFocus":['
        : '{"paragraphs":[{"paragraphId":"p2","sentenceFocus":[]}]}' }
    },
  })
  const result = await adapter.requestLinkageParagraphBatch({
    stage: 'overview', paragraphIds: ['p1', 'p2'], maxTokens: 1000,
    messages: [{ role: 'user', content: JSON.stringify({ paragraphs: [{ paragraphId: 'p1' }, { paragraphId: 'p2' }] }) }],
  })
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1].messages[0].content).paragraphs.length, 1)
  assert.equal(JSON.parse(calls[1].messages[0].content).paragraphs[0].paragraphId, 'p2')
  assert.equal(result.paragraphs.length, 2)
})

test('持续非法模型输出只重试一次，不返回伪成功或覆盖已有数据', async () => {
  let calls = 0
  const adapter = loadFunctions('../src/intelligence/linkage-response.ts', [
    'hasStageFields', 'parseLinkageParagraphResponse', 'requestLinkageParagraphBatch',
  ], { createChatCompletion: async () => { calls++; return { content: 'not valid JSON' } } })
  await assert.rejects(adapter.requestLinkageParagraphBatch({
    stage: 'overview', paragraphIds: ['p1'], maxTokens: 1000, messages: [],
  }), /原文和已有关联均未改动/)
  assert.equal(calls, 2)
})

test('工作区异步刷新采用最新手动选中文件，不被旧闭包清空', () => {
  const ref = { current: 'file-B' }
  let previewId = null
  const noop = () => {}
  const { applyWorkspace } = loadFunctions('../../app/src/App.tsx', ['applyWorkspace'], {
    manualPreviewEvidenceId: null, manualPreviewEvidenceIdRef: ref,
    selectedCaseId: 'case1', selectedCertificateId: null, activeParagraphId: null,
    selectedEvidenceIds: [], locatorDraft: '',
    localWorkspaceRef: {}, cloudAccountProfileRef: {}, cloudPointsSyncRef: {}, activeSentenceAnchorRef: { current: null },
    normalizeWorkspaceState: x => x, enrichWorkspaceWithCloudProfile: x => x, mergeWorkspaceWithCloudPoints: x => x,
    deriveSelection: (_, selection) => selection,
    findSelectedParagraph: () => null, resolveParagraphSentenceSelection: () => ({ index: null, text: '' }),
    getParagraphLinks: () => [],
    setAppState: noop, setSelectedCaseId: noop, setSelectedCertificateId: noop, setActiveParagraphId: noop,
    setSelectedEvidenceIds: noop, setImageViewerState: noop, setLocatorDraft: noop, setActiveSentenceIndex: noop, setActiveSentenceText: noop,
    setManualPreviewEvidenceId: id => { ref.current = id; previewId = id },
  })
  const workspace = { evidences: [{ id: 'file-B', caseId: 'case1' }] }
  applyWorkspace(workspace)
  assert.equal(previewId, 'file-B')
  applyWorkspace(workspace, {}, { preserveManualPreview: true })
  assert.equal(previewId, 'file-B')
  applyWorkspace(workspace, {}, { preserveManualPreview: false })
  assert.equal(previewId, null)
  ref.current = 'file-B'
  applyWorkspace(workspace, { selectedCaseId: 'case2' })
  assert.equal(previewId, null)
})
