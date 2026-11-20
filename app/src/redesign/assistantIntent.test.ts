import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantIntent } from './assistantIntent.ts'

test('仅将明确的自然语言指令路由到生产助手技能', () => {
  assert.deepEqual(assistantIntent('请在卷内查找：转账500元'), { skill: 'inbox-search', query: '转账500元' })
  assert.deepEqual(assistantIntent('查法条《民法典》第五百七十七条'), { skill: 'statute-mcp', query: '《民法典》第五百七十七条' })
  assert.deepEqual(assistantIntent('请复算借款利息'), { skill: 'calc', query: '借款利息' })
  assert.deepEqual(assistantIntent('生成案例检索报告'), { skill: 'case-report', query: '' })
  assert.deepEqual(assistantIntent('归纳本案争议焦点'), { skill: 'focus', query: '' })
  assert.deepEqual(assistantIntent('梳理本案时间线'), { skill: 'timeline', query: '' })
  assert.equal(assistantIntent('借款金额还需要哪些证据？'), undefined)
})

test('能从简称、编号和不同写法识别明确意图，并保留检索所需原文', () => {
  assert.deepEqual(assistantIntent('民法典第 577 条'), { skill: 'statute-mcp', query: '民法典第577条' })
  assert.deepEqual(assistantIntent('《合同法》第107条还有效吗？'), { skill: 'statute-mcp', query: '《合同法》第107条还有效吗？' })
  assert.deepEqual(assistantIntent('帮我查一下（2021）京01民终1234号'), { skill: 'case-mcp', query: '（2021）京01民终1234号' })
  assert.deepEqual(assistantIntent('查一下法条：民法典第 577 条'), { skill: 'statute-mcp', query: '民法典第577条' })
  assert.equal(assistantIntent('帮我写一份民间借贷民事起诉状，引用《民法典》第675条')?.skill, 'draft')
  assert.deepEqual(assistantIntent('导出案例'), { skill: 'case-report', query: '' })
  assert.deepEqual(assistantIntent('查一下本案的付款凭证'), { skill: 'inbox-search', query: '付款凭证' })
  assert.equal(assistantIntent('请把这段写得更严谨')?.skill, 'rewrite')
  assert.equal(assistantIntent('被告认为本案不适用《民法典》第577条'), undefined)
})

test('省略工具名的续问使用上一次检索模式，明确的新指令优先', () => {
  const law = { skill: 'statute-mcp', query: '民法典第577条' } as const
  const cases = { skill: 'case-mcp', query: '民间借贷' } as const
  assert.deepEqual(assistantIntent('那第578条呢？', law), { skill: 'statute-mcp', query: '民法典第578条' })
  assert.deepEqual(assistantIntent('还有北京的呢？', cases), { skill: 'case-mcp', query: '民间借贷 北京的' })
  assert.deepEqual(assistantIntent('还有吗？', cases), { skill: 'case-mcp', query: '' })
  assert.deepEqual(assistantIntent('再查法条《民法典》第577条', cases), { skill: 'statute-mcp', query: '《民法典》第577条' })
  assert.equal(assistantIntent('还有吗？'), undefined)
})
