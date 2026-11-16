import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildProjects, paragraphElements } from './model.ts'

const workspace: any = {
  cases: [
    { id: 'case', name: '真实案件', description: '', createdAt: '2026-11-15' },
  ],
  certificates: [
    { id: 'document', caseId: 'case', title: '起诉状', paragraphs: [] },
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
import { reviewReadiness, reanchorParagraph } from './workflow.ts'

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
  assert.equal(paragraphElements(p, state as any, 'document')[0].verdict, 'warn')
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
