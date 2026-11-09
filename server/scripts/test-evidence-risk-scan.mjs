import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scanEvidenceRisks } from '../src/intelligence/evidence-risk-scan.ts'

test('举证期限与形式要件被标为高风险', () => {
  const findings = scanEvidenceRisks('本院通知被告在收到通知书之日起十五日内举证，逾期视为放弃权利。')
  const deadline = findings.find((item) => item.kind === 'limitation-deadline')
  assert.ok(deadline)
  assert.equal(deadline.severity, 'high')
  assert.ok(deadline.excerpt)

  const form = scanEvidenceRisks('该协议应当采用书面形式，未公证的鉴定意见不得作为定案依据。')
  assert.ok(form.find((item) => item.kind === 'evidence-form'))
})

test('签字盖章缺失被升级为高风险', () => {
  const findings = scanEvidenceRisks('合同末页仅有打印内容，未签字未盖章。')
  const signature = findings.find((item) => item.kind === 'signature-seal')
  assert.ok(signature)
  assert.equal(signature.severity, 'high')
  assert.match(signature.message, /签字或盖章缺失/)
})

test('只有签章正常时不升级风险等级', () => {
  const findings = scanEvidenceRisks('合同已由双方签字盖章，签署人为公司法定代表人。')
  const signature = findings.find((item) => item.kind === 'signature-seal')
  assert.equal(signature?.severity, 'medium')
})

test('已核对原件时不再提示原件缺失', () => {
  const withOriginal = scanEvidenceRisks('该复印件已与原件核对无误，副本留存于卷宗。')
  assert.equal(withOriginal.find((item) => item.kind === 'original-missing'), undefined)

  const withoutOriginal = scanEvidenceRisks('仅提供复印件，原件未随卷提交。')
  assert.ok(withoutOriginal.find((item) => item.kind === 'original-missing'))
})

test('页码连续性与送达地址单独提示', () => {
  const findings = scanEvidenceRisks('合同共 12 页，第 3 页与第 4 页之间内容缺失，约定送达地址为被告住所地。')
  assert.ok(findings.find((item) => item.kind === 'page-continuity'))
  assert.ok(findings.find((item) => item.kind === 'delivery-address'))
})

test('空白材料不产生风险', () => {
  assert.deepEqual(scanEvidenceRisks(''), [])
  assert.deepEqual(scanEvidenceRisks('   \n  '), [])
})
