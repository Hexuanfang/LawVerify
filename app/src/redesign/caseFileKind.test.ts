import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceCategory, detectCaseFileKind } from './caseFileKind.ts'

test('按业务类型归组，文件名无特征时使用目录名', () => {
  assert.equal(evidenceCategory('借条原件.jpg'), '合同协议')
  assert.equal(evidenceCategory('招商银行流水.png'), '资金往来')
  assert.equal(evidenceCategory('微信聊天截图.png'), '沟通记录')
  assert.equal(evidenceCategory('被告户籍信息.pdf'), '身份主体')
  assert.equal(evidenceCategory('一审判决书.pdf'), '前审文书')
  assert.equal(evidenceCategory('01.pdf', ['沟通记录', '2023年']), '沟通记录')
  assert.equal(evidenceCategory('01.pdf', ['沟通记录', '2023年', '转账回单']), '资金往来')
  assert.equal(evidenceCategory('附件.pdf'), '其他')
})

test('同一批文件区分待核验文书与作为证据的 Word、原审文书和图片', async () => {
  const kind = (name: string, text = '') => detectCaseFileKind(new File([text], name))
  assert.equal(await kind('民事起诉状.docx'), 'document')
  assert.equal(await kind('合同纠纷起诉状.docx'), 'document')
  assert.equal(await kind('证据清单.docx'), 'document')
  assert.equal(await kind('证据清单-复印件.docx'), 'evidence')
  assert.equal(await kind('扫描件.txt', '\uFEFF# 民事答辩状\n答辩人：张某'), 'document')
  assert.equal(await kind('借款协议.docx'), 'evidence')
  assert.equal(await kind('一审民事答辩状.docx'), 'evidence')
  assert.equal(await kind('一审判决书.pdf'), 'evidence')
  assert.equal(await kind('起诉状-附件.png'), 'evidence')
  assert.equal(await kind('不明文件.docx'), 'evidence')
})
