import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { AppError } from '../src/core/app-error.ts'
import { ModelRedaction } from '../src/integrations/model-redaction.ts'
import { planLinkageParagraphBatches } from '../src/intelligence/linkage-batching.ts'
import './test-linkage-batching.mjs'
import * as policy from '../src/intelligence/linkage-policy.ts'
import { normalizeDocKey, profile as documentProfile } from '../src/intelligence/verification/profile.ts'
import { parseModelDeclarationCandidates } from '../src/intelligence/verification/extract.ts'
import { confirmedDeclarationsForFullRecheck, invalidateVerification, mergeConfirmedDeclarations, verificationAuthorityKey } from '../src/intelligence/verification/review-state.ts'
import { buildClaimUnits, buildClaimEvidenceMatches, buildEvidenceFragments } from '../src/intelligence/evidence-matching.ts'

test('全文重核保留已确认的有效锚点，材料、上游变化或待核验会解除保留', () => {
  const workspace = { knowledgeCases: [], knowledgeStatutes: [] }
  const paragraphs = ['原告已付款。', '被告已收款。', '交付无异议。'].map((text, index) => ({ id: `p${index}`, text, verified: false }))
  const declarations = paragraphs.map(({ text, id }, index) => ({
    id, quote: text, type: 'E-FACT', verdict: index === 2 ? 'pending' : 'pass', checks: {}, review: { decision: 'confirmed' },
    location: { paragraphId: id, paragraphIndex: index, start: 0, end: text.length },
    sources: [{ tier: 'l1', id: 'document', name: '流水', locator: '第 1 页', quote: text }],
    ...(index === 1 && { dependencies: [{ id: 'p0', check: 'B4' }] }),
  }))
  const verification = { profileVersion: documentProfile.version, docKey: 'qs', inputKey: 'materials',
    materialVersion: 'v1', authorityKey: verificationAuthorityKey(workspace, declarations), declarations }
  const certificate = { paragraphs, linkageInputKey: 'materials', docKey: 'qs', verification }
  const frozen = confirmedDeclarationsForFullRecheck(certificate, workspace, documentProfile.version, 'materials', 'v1')
  assert.deepEqual([...frozen.keys()], ['p0', 'p1'])
  const changedModel = { ...declarations[0], id: 'p0-model', quote: '已付款', location: { ...declarations[0].location, start: 2, end: 5 } }
  assert.deepEqual(mergeConfirmedDeclarations([changedModel, declarations[2]], frozen, 'qs'), declarations)
  assert.equal(confirmedDeclarationsForFullRecheck(certificate, workspace, documentProfile.version, 'materials', 'v2').size, 0)
  assert.equal(confirmedDeclarationsForFullRecheck({ ...certificate, verification: { ...verification,
    dirty: { paragraphIds: ['p0'], declarationIds: [] } } }, workspace, documentProfile.version, 'materials', 'v1').size, 0)
})

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
  // 默认桩：模型调用缓存直通（缓存本身由 test-llm-call-cache.mjs 覆盖），并提供浏览器的 AbortController。
  const defaultMocks = {
    withLlmCallCache: async (_namespace, _payload, run) => ({ value: await run(), reused: false }),
    currentModelRedaction: () => undefined,
    planLinkageParagraphBatches,
    AbortController,
  }
  const context = vm.createContext({ ...policy, normalizeDocKey, documentProfile, parseModelDeclarationCandidates, ...defaultMocks, ...mocks })
  vm.runInContext(ts.transpileModule(
    snippets.join('\n') + '\nthis.exports={' + names.join(',') + '};',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText, context)
  return context.exports
}

const serviceFile = '../src/service.ts'

test('核验被解析失败阻塞时带出材料编号和真实原因，继续阻止未就绪材料进入核验', async () => {
  for (const status of ['failed', 'queued', 'processing', 'review_required']) {
    const workspace = {
      certificates: [{ id: 'document', caseId: 'case', paragraphs: [] }],
      evidences: [{ id: 'material', caseId: 'case', number: 'E001',
        parsing: { status, error: status === 'failed' ? '暂时无法获取解析凭据。' : undefined } }],
    }
    const { autoLinkCertificate } = loadFunctions(serviceFile, ['autoLinkCertificate'], {
      isLlmConfigured: () => true,
      withRequestAbortSignal: (_signal, run) => run(),
      withModelRedaction: run => run(),
      resetLlmCallCacheHitCount: () => {},
      getLlmCallCacheHitCount: () => 0,
      readWorkspace: async () => workspace,
      throwIfLinkageAborted: () => {},
      verificationMaterialVersion: () => 'current-material-version',
      learnCaseRedaction: () => {},
      AppError,
      rebuildCaseContextMemory: () => assert.fail('未就绪材料不能进入模型核验'),
    })
    await assert.rejects(autoLinkCertificate('document'), error => {
      assert.equal(error.code, 'CASE_PARSE_REVIEW_REQUIRED')
      if (status === 'failed') {
        assert.match(error.message, /1 份.*解析失败/)
        assert.match(error.message, /E001/)
        assert.match(error.message, /暂时无法获取解析凭据/)
        assert.match(error.message, /重新解析/)
      } else {
        assert.match(error.message, /解析或等待人工审核/)
      }
      return true
    })
  }
})

test('只修改备注或格式不重新识别法条，也不删除已有自动法条', async () => {
  const paragraph = {
    id: 'p', text: '原文', richText: '<p>原文</p>',
    references: [{ id: 'r', note: 'system:auto-statute-detected' }],
  }
  let saved
  const workspace = { user: { email: 'format-only@test.invalid' }, certificates: [{ id: 'c', paragraphs: [paragraph] }] }
  const { updateParagraph } = loadFunctions(serviceFile, ['updateParagraph'], {
    readWorkspace: async () => saved ?? workspace,
    writeWorkspace: async state => { saved = state },
    normalizeParagraph: p => p,
    getCurrentWorkspaceAccount: () => undefined,
    invalidateVerification,
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


test('单段预计输出超过硬预算时保留全文并明确报错', async () => {
  let calls = 0
  const adapter = loadFunctions('../src/intelligence/linkage-response.ts', [
    'hasStageFields', 'parseLinkageParagraphResponse', 'requestLinkageParagraphBatch',
  ], { createChatCompletion: async () => { calls++; assert.fail('输出超限不应请求模型') } })
  const paragraph = { paragraphId: 'long', text: fact.repeat(70) }
  const content = JSON.stringify({ paragraphs: [paragraph] })
  await assert.rejects(adapter.requestLinkageParagraphBatch({
    stage: 'overview', paragraphIds: ['long'], maxTokens: 10000,
    messages: [{ role: 'user', content }],
  }), /单段核验预计输出超过/)
  assert.equal(calls, 0)
  assert.equal(JSON.parse(content).paragraphs[0].text, fact.repeat(70))
})

test('核验服务将完整段落交给两阶段组批，取消固定段数与正文分组限制', async () => {
  const cases = [
    { lengths: [30, 30, 30, 30, 30, 30, 30], sizes: [7], tokens: [10000] },
    { lengths: [3000, 3000, 30], sizes: [3], tokens: [10000] },
    { lengths: [30, 30, 30, 30], sizes: [4], tokens: [10000] },
    { lengths: [6001, 30], sizes: [2], tokens: [10000] },
  ]
  for (const { lengths, sizes, tokens } of cases) {
    const calls = []
    const paragraphs = lengths.map((length, index) => ({ id: `p${index}`, text: fact + '文'.repeat(length - fact.length) }))
    const { analyzeCertificateAutoLinksWithLlm } = loadFunctions(serviceFile, [
      'analyzeCertificateAutoLinksWithLlm',
      'normalizeAutoLinkSignalList', 'normalizeAutoLinkEvidenceIntents',
      'normalizeAutoLinkStatuteIntents', 'normalizeAutoLinkCaseIntents',
    ], {
      isLlmConfigured: () => true,
      buildParagraphAutoLinkPayload: (_, __, chunk) => chunk.map(p => ({ paragraphId: p.id, text: p.text })),
      requestLinkageParagraphBatch: async options => {
        calls.push(options)
        return { paragraphs: options.paragraphIds.map(paragraphId => ({
          paragraphId,
          sentenceFocus: focusFor(paragraphs.find(p => p.id === paragraphId).text),
          evidenceLinks: [], statuteIntents: [], caseIntents: [],
        })) }
      },
    })
    const result = await analyzeCertificateAutoLinksWithLlm({ cases: [] }, { paragraphs }, [], null)
    assert.equal(calls.length, sizes.length * 2)
    for (const stage of ['overview', 'links']) {
      const stageCalls = calls.filter(call => call.stage === stage)
      assert.deepEqual(stageCalls.map(call => call.paragraphIds.length), sizes)
      assert.deepEqual(stageCalls.map(call => call.maxTokens), tokens)
      const sent = stageCalls.flatMap(call => JSON.parse(call.messages[1].content).paragraphs)
      assert.deepEqual(sent.map(p => ({ id: p.paragraphId, text: p.text })), paragraphs)
    }
    assert.deepEqual(Array.from(result.keys()), paragraphs.map(p => p.id))
  }
})

test('核验服务与真实组批适配器联动，两阶段独立组批并报告实际处理段落', async () => {
  const paragraphs = Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, text: fact.repeat(10) }))
  const calls = []
  const progress = []
  const adapter = loadFunctions('../src/intelligence/linkage-response.ts', [
    'hasStageFields', 'parseLinkageParagraphResponse', 'requestLinkageParagraphBatch',
  ], {
    createChatCompletion: async options => {
      const payload = JSON.parse(options.messages[1].content)
      const stage = options.messages[0].content.includes('整体理解助手') ? 'overview' : 'links'
      calls.push({ stage, ids: payload.paragraphs.map(p => p.paragraphId), maxTokens: options.maxTokens })
      return { content: JSON.stringify({ paragraphs: payload.paragraphs.map(p => ({
        paragraphId: p.paragraphId, sentenceFocus: focusFor(p.text), evidenceLinks: [], statuteIntents: [], caseIntents: [],
      })) }) }
    },
  })
  const service = loadFunctions(serviceFile, [
    'analyzeCertificateAutoLinksWithLlm', 'normalizeAutoLinkSignalList',
    'normalizeAutoLinkEvidenceIntents', 'normalizeAutoLinkStatuteIntents', 'normalizeAutoLinkCaseIntents',
  ], {
    isLlmConfigured: () => true,
    buildParagraphAutoLinkPayload: (_, __, items) => items.map(p => ({
      paragraphId: p.id, text: p.text, sentenceGroups: policy.getLinkageSentences(p.text),
      evidenceCandidates: Array.from({ length: 12 }, (_, index) => ({ evidenceNumber: `E${index}` })),
    })),
    requestLinkageParagraphBatch: adapter.requestLinkageParagraphBatch,
  })
  const result = await service.analyzeCertificateAutoLinksWithLlm({ cases: [] }, { paragraphs }, [], null, text => progress.push(text))
  assert.deepEqual(calls.filter(call => call.stage === 'overview').map(call => call.ids), [['p0', 'p1', 'p2', 'p3'], ['p4', 'p5']])
  assert.deepEqual(calls.filter(call => call.stage === 'links').map(call => call.ids), [['p0', 'p1'], ['p2', 'p3'], ['p4', 'p5']])
  assert.ok(calls.every(call => call.maxTokens <= 10000))
  assert.ok(progress.some(text => /理解.*第 1–4 段/.test(text)))
  assert.ok(progress.some(text => /核对.*第 3–4 段/.test(text)))
  assert.deepEqual(Array.from(result.keys()), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'])
})

test('动态组批取消时停止后续调用，重试复用成功批次并保留结果顺序', async () => {
  const paragraphs = [0, 1, 2].map(index => ({ paragraphId: `p${index}`, text: '文'.repeat(80000) }))
  const cache = new Map()
  const calls = []
  let cancelOnce = true
  const adapter = loadFunctions('../src/intelligence/linkage-response.ts', [
    'hasStageFields', 'parseLinkageParagraphResponse', 'requestLinkageParagraphBatch',
  ], {
    withLlmCallCache: async (namespace, payload, run) => {
      const key = JSON.stringify({ namespace, payload })
      if (cache.has(key)) return { value: cache.get(key), reused: true }
      const value = await run()
      cache.set(key, value)
      return { value, reused: false }
    },
    createChatCompletion: async options => {
      const sent = JSON.parse(options.messages[0].content).paragraphs
      calls.push(sent[0].paragraphId)
      if (sent[0].paragraphId === 'p1' && cancelOnce) {
        cancelOnce = false
        throw Object.assign(new Error('已取消'), { name: 'AbortError' })
      }
      return { content: JSON.stringify({ paragraphs: sent.map(p => ({ paragraphId: p.paragraphId, sentenceFocus: [] })) }) }
    },
  })
  const options = {
    stage: 'overview', paragraphIds: ['p0', 'p1', 'p2'], maxTokens: 10000,
    messages: [{ role: 'user', content: JSON.stringify({ paragraphs }) }],
  }
  await assert.rejects(adapter.requestLinkageParagraphBatch(options), { name: 'AbortError' })
  assert.deepEqual(calls, ['p0', 'p1'])
  const result = await adapter.requestLinkageParagraphBatch(options)
  assert.deepEqual(calls, ['p0', 'p1', 'p1', 'p2'])
  assert.deepEqual(Array.from(result.paragraphs, p => p.paragraphId), ['p0', 'p1', 'p2'])
})

test('整篇动态组批混合关联与跳过段落时保留全部理解元数据', async () => {
  const paragraphs = [{ id: 'active', text: fact }, { id: 'skip', text: '当事人应遵循诚实信用原则。' }]
  const overview = {
    paragraphId: 'skip', paragraphSummary: '背景原则', paragraphRole: '背景', argumentGoal: '交代原则',
    proofRequirements: ['无需举证'], legalIssues: ['原则说明'], caseSearchTopics: ['背景线索'],
    sentenceFocus: [{ sentenceIndex: 0, kind: 'background', priority: 'skip', reason: '背景' }],
  }
  const service = loadFunctions(serviceFile, [
    'analyzeCertificateAutoLinksWithLlm', 'normalizeAutoLinkSignalList',
    'normalizeAutoLinkEvidenceIntents', 'normalizeAutoLinkStatuteIntents', 'normalizeAutoLinkCaseIntents',
  ], {
    isLlmConfigured: () => true,
    uniqueStrings: (items, limit) => [...new Set(items)].slice(0, limit),
    buildParagraphAutoLinkPayload: (_, __, items) => items.map(p => ({ paragraphId: p.id, text: p.text })),
    requestLinkageParagraphBatch: async options => ({ paragraphs: options.stage === 'overview'
      ? [{ paragraphId: 'active', sentenceFocus: focusFor(fact) }, overview]
      : [{ paragraphId: 'active', evidenceLinks: [], statuteIntents: [], caseIntents: [] }] }),
  })
  const result = await service.analyzeCertificateAutoLinksWithLlm({ cases: [] }, { paragraphs }, [], null)
  const skipped = result.get('skip')
  assert.equal(skipped.paragraphSummary, '背景原则')
  assert.equal(skipped.paragraphRole, '背景')
  assert.equal(skipped.argumentGoal, '交代原则')
  assert.deepEqual(Array.from(skipped.proofRequirements), ['无需举证'])
  assert.deepEqual(Array.from(skipped.legalIssues), ['原则说明'])
  assert.deepEqual(Array.from(skipped.caseSearchTopics), ['背景线索'])
  assert.equal(skipped.sentenceFocus[0].priority, 'skip')
  assert.equal(skipped.evidenceLinks.length, 0)
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
    stage: 'overview', paragraphIds: ['p1', 'p2'], maxTokens: 6000,
    messages: [{ role: 'user', content: JSON.stringify({ paragraphs: [{ paragraphId: 'p1' }, { paragraphId: 'p2' }] }) }],
  })
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1].messages[0].content).paragraphs.length, 1)
  assert.equal(JSON.parse(calls[1].messages[0].content).paragraphs[0].paragraphId, 'p2')
  assert.equal(result.paragraphs.length, 2)
})

test('完整核验消息超限时自动拆批，保留案件上下文和各段候选证据', async () => {
  for (const stage of ['overview', 'links']) {
    const paragraphs = Array.from({ length: 5 }, (_, index) => ({
      paragraphId: `p${index}`, text: fact,
      evidenceCandidates: [{ evidenceNumber: 'E01', summary: '证'.repeat(32000) }],
    }))
    const payload = { caseContextMemory: { summary: '案件背景' }, paragraphs }
    assert.ok(JSON.stringify(payload).length > 150000)
    const calls = []
    const adapter = loadFunctions('../src/intelligence/linkage-response.ts', [
      'hasStageFields', 'parseLinkageParagraphResponse', 'requestLinkageParagraphBatch',
    ], {
      createChatCompletion: async options => {
        assert.ok(options.messages.every(message => message.content.length <= 150000))
        const sent = JSON.parse(options.messages[1].content)
        calls.push(sent)
        return { content: JSON.stringify({ paragraphs: sent.paragraphs.map(p => ({
          paragraphId: p.paragraphId, sentenceFocus: [], evidenceLinks: [], statuteIntents: [], caseIntents: [],
        })) }) }
      },
    })
    const result = await adapter.requestLinkageParagraphBatch({
      stage, paragraphIds: paragraphs.map(p => p.paragraphId), maxTokens: 10000,
      messages: [{ role: 'system', content: '核验提示' }, { role: 'user', content: JSON.stringify(payload) }],
    })
    assert.equal(calls.length, 5)
    assert.deepEqual(calls.flatMap(call => call.paragraphs), paragraphs)
    assert.ok(calls.every(call => call.caseContextMemory.summary === '案件背景'))
    assert.deepEqual(Array.from(result.paragraphs, p => p.paragraphId), ['p0', 'p1', 'p2', 'p3', 'p4'])
  }
})

test('完整核验消息按大小分批直至每条消息均满足长度上限', async () => {
  const paragraphs = Array.from({ length: 5 }, (_, index) => ({ paragraphId: `p${index}`, text: '文'.repeat(80000) }))
  let calls = 0
  const adapter = loadFunctions('../src/intelligence/linkage-response.ts', [
    'hasStageFields', 'parseLinkageParagraphResponse', 'requestLinkageParagraphBatch',
  ], {
    createChatCompletion: async options => {
      assert.ok(options.messages[0].content.length <= 150000)
      const sent = JSON.parse(options.messages[0].content)
      calls++
      return { content: JSON.stringify({ paragraphs: sent.paragraphs.map(p => ({ paragraphId: p.paragraphId, sentenceFocus: [] })) }) }
    },
  })
  const result = await adapter.requestLinkageParagraphBatch({
    stage: 'overview', paragraphIds: paragraphs.map(p => p.paragraphId), maxTokens: 6000,
    messages: [{ role: 'user', content: JSON.stringify({ paragraphs }) }],
  })
  assert.equal(calls, 5)
  assert.equal(result.paragraphs.length, 5)
})

test('核验消息长度检查计入隐私脱敏后的膨胀', async () => {
  const redaction = new ModelRedaction()
  redaction.addNames(['张三'])
  const paragraphs = [0, 1].map(index => ({ paragraphId: `p${index}`, text: '张三'.repeat(3500) }))
  const content = JSON.stringify({ paragraphs })
  assert.ok(content.length < 150000)
  assert.ok(redaction.redact(content).length > 150000)
  let calls = 0
  const adapter = loadFunctions('../src/intelligence/linkage-response.ts', [
    'hasStageFields', 'parseLinkageParagraphResponse', 'requestLinkageParagraphBatch',
  ], {
    currentModelRedaction: () => redaction,
    createChatCompletion: async options => {
      assert.ok(redaction.redact(options.messages[0].content).length <= 150000)
      calls++
      const sent = JSON.parse(options.messages[0].content)
      return { content: JSON.stringify({ paragraphs: sent.paragraphs.map(p => ({ paragraphId: p.paragraphId, sentenceFocus: [] })) }) }
    },
  })
  await adapter.requestLinkageParagraphBatch({
    stage: 'overview', paragraphIds: ['p0', 'p1'], maxTokens: 6000,
    messages: [{ role: 'user', content }],
  })
  assert.equal(calls, 2)
})
test('单段或共享上下文独自超限时明确报错，停止发送超限模型请求', async () => {
  for (const payload of [
    { paragraphs: [{ paragraphId: 'p1', text: '文'.repeat(150001) }] },
    { caseContextMemory: '背'.repeat(150001), paragraphs: [{ paragraphId: 'p1', text: fact }, { paragraphId: 'p2', text: fact }] },
  ]) {
    const adapter = loadFunctions('../src/intelligence/linkage-response.ts', [
      'hasStageFields', 'parseLinkageParagraphResponse', 'requestLinkageParagraphBatch',
    ], { createChatCompletion: async () => { assert.fail('超限内容不应发出模型请求') } })
    await assert.rejects(adapter.requestLinkageParagraphBatch({
      stage: 'overview', paragraphIds: payload.paragraphs.map(p => p.paragraphId), maxTokens: 6000,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }), /单段核验内容.*150000/)
  }
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
