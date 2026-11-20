import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const cases = {
  'inbox-search': { type: 'citation-card', material_name: '回单', loc: '第1页', excerpt: '摘要' },
  'statute-mcp': { type: 'citation-card', law_name: '民法典', article_number: '第一条', validity: 'VALID', text: '原文', url: 'https://example.test/law' },
  'case-mcp': { type: 'citation-card', case_number: '（2025）测试1号', court: '测试法院', judgment_date: '2025-01-01', gist: '要旨', hit_level: '近似类比', url: 'https://example.test/case' },
  draft: { type: 'draft-doc', docType: 'qs', items: [{ type: 'E-FACT', quote: '候选', loc: { paragraphId: 'p', paragraphIndex: 0, start: 0, end: 2 }, sources: [] }] },
  rewrite: { type: 'draft-paragraph', verifiedCandidate: '候选' },
  evidence: { type: 'analysis-card', authenticity: [], legality: [], relevance: [], probative: [], reinforce: [] },
  chain: { type: 'analysis-card', breaks: [] },
  calc: { type: 'analysis-card', formula: ['1元×10%×1天÷365天'], inputs: ['来源：回单'], result: ['0元'] },
  risk: { type: 'analysis-card', risks: [], actions: [] },
  focus: { type: 'analysis-card', ourIssues: [], theirIssues: [], shared: [] },
  timeline: { type: 'analysis-card', events: [] },
  'case-report': { type: 'docx-case-report', task: '检索任务', overview: '结果概览', list: [], excerpts: [], disclaimer: '以官方来源为准' },
}

test('运行时注册与交付契约一致，禁止覆盖防编造与确认开关', async () => {
  const { assistantSkillContract, assistantSkills, getAssistantSkill } = await import('../src/assistant/skill-contract.ts')
  const published = JSON.parse(await readFile(new URL('../../docs/prd开发交付/skills.prod.json', import.meta.url), 'utf8'))
  assert.deepEqual(assistantSkillContract, published)
  assert.deepEqual(assistantSkills.map(skill => skill.id), Object.keys(cases))
  assert.equal(getAssistantSkill('toString'), undefined)
  assert.throws(() => { assistantSkillContract.guardGlobal.forbidFabricate = false }, TypeError)
  for (const id of ['inbox-search', 'statute-mcp', 'case-mcp', 'draft', 'rewrite', 'case-report']) {
    assert.equal(getAssistantSkill(id).guard.needLawyerConfirm, true)
    assert.throws(() => { getAssistantSkill(id).guard.forbidFabricate = false }, TypeError)
  }
})

test('十二项输出校验类型、必填字段、条款效力、案例分层和草稿声明字段', async () => {
  const { validateSkillOutput } = await import('../src/assistant/skill-contract.ts')
  for (const [id, output] of Object.entries(cases)) {
    assert.doesNotThrow(() => validateSkillOutput(id, output), id)
    assert.throws(() => validateSkillOutput(id, { ...output, type: 'other' }), /type/, id)
    for (const key of Object.keys(output).filter(key => key !== 'type')) {
      const { [key]: omitted, ...partial } = output
      assert.throws(() => validateSkillOutput(id, partial), new RegExp(key), id)
    }
  }
  assert.throws(() => validateSkillOutput('unknown', {}), /unknown/)
  assert.throws(() => validateSkillOutput('statute-mcp', { ...cases['statute-mcp'], validity: 'effective' }), /validity/)
  assert.throws(() => validateSkillOutput('case-mcp', { ...cases['case-mcp'], hit_level: '类似' }), /hit_level/)
  assert.throws(() => validateSkillOutput('inbox-search', { ...cases['inbox-search'], loc: '  ' }), /loc/)
  assert.throws(() => validateSkillOutput('draft', { ...cases.draft, items: [{ ...cases.draft.items[0], sources: false }] }), /sources/)
  assert.throws(() => validateSkillOutput('draft', { ...cases.draft, items: [{ ...cases.draft.items[0], loc: {} }] }), /loc/)
})
