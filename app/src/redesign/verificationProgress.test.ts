import test from 'node:test'
import assert from 'node:assert/strict'
import { verificationStep, verificationRowState } from './verificationProgress.ts'

test('真实核验事件分别映射到六个阶段', () => {
  const events = [
    '正在读取文书与案件材料',
    '正在梳理案件背景、争议焦点与证据薄弱点',
    '正在核对第 1 组内容的证据原文与句级关联',
    '正在核验争议对应的法律依据',
    '正在核验相关案例与裁判规则',
    '正在保存联动结果',
  ]
  assert.deepEqual(events.map(verificationStep), [0, 1, 2, 3, 4, 5])
})
test('材料理解与比对的细分事件保持正确阶段', () => {
  assert.equal(verificationStep('正在理解第 1 组内容的关键事实、争议与证明要求'), 1)
  assert.equal(verificationStep('正在比对 3 段关键内容与 10 份案件材料'), 2)
  assert.equal(verificationStep('正在按争议焦点补齐超大材料的理解'), 2)
  assert.equal(verificationStep('正在整理证据与关键句子的证明关系'), 2)
  assert.equal(verificationStep('正在保存联动结果（已复用 2 项模型结果）'), 5)
})
test('完成时六个阶段均为完成，停止时当前阶段不能显示处理中', () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => verificationRowState(6, index, true, false)), Array(6).fill('done'))
  assert.equal(verificationRowState(2, 2, false, true), 'stopped')
  assert.equal(verificationRowState(2, 1, false, true), 'done')
  assert.equal(verificationRowState(2, 3, false, true), 'pending')
  assert.equal(verificationRowState(2, 2, false, false), 'active')
})
