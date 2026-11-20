import assert from 'node:assert/strict'
import test from 'node:test'
import * as verificationMemory from './verificationMemory.ts'
import type { AppState } from '../types.ts'
import type { ReviewElement } from './model.ts'

const calculation = { principal: 10000, rate: 0.1, days: 365, annualDays: 365, amount: 1000 }
const location = { paragraphId: 'p', paragraphIndex: 0, start: 0, end: 3 }
const source = { tier: 'l1' as const, id: 'e', name: '本金凭证', locator: '第 1 页', quote: '本金' }
const declaration = { id: 'decl', location, quote: '利息项', type: 'E-CALC', verdict: 'pass', checks: {}, sources: [source, { ...source, id: 'outside' }], calculation }
const certificate = { id: 'doc', caseId: 'case', title: '起诉状', linkageInputKey: 'current', paragraphs: [{ id: 'p', text: '利息项' }], verification: { inputKey: 'current', declarations: [declaration] } }
const workspace = { certificates: [certificate], evidences: [{ id: 'e', caseId: 'case' }, { id: 'outside', caseId: 'other' }] } as unknown as AppState

test('案件记忆仅展示当前文书中可回查的本案材料复算和原文定位', () => {
  const { verifiedCaseMemory } = verificationMemory
  const snapshots = verifiedCaseMemory(workspace, 'case')
  assert.equal(snapshots.length, 1)
  assert.deepEqual(snapshots[0].sources, [source])
  assert.deepEqual(snapshots[0].calculation, calculation)
  assert.deepEqual(verifiedCaseMemory(workspace, 'other'), [])
  assert.deepEqual(verifiedCaseMemory({ ...workspace, certificates: workspace.certificates.map(item => ({ ...item, linkageStale: true })) }, 'case'), [])
  assert.deepEqual(verifiedCaseMemory({ ...workspace, evidences: [] }, 'case'), [])
})

test('金额台账核对复算输入的版本，其他有效材料不能代替失效的复算依据', () => {
  const basis = { ...source, id: 'settlement', version: 'v1' }
  const balance = { kind: 'trade-balance', total: 576000, paid: 200000, amount: 376000, sources: [basis] }
  const trade = { ...declaration, sources: [source, basis], calculation: balance }
  const state = { ...workspace, certificates: [{ ...certificate, verification: { ...certificate.verification, declarations: [trade] } }],
    evidences: [...workspace.evidences, { id: 'settlement', caseId: 'case', contentHash: 'v1' }] } as unknown as AppState
  const [current] = verificationMemory.verifiedCaseMemory(state, 'case')
  assert.deepEqual(current.calculation, balance)
  assert.match(verificationMemory.formatVerificationCalculation(current.calculation!), /576000.*−.*200000.*=.*376000\.00/u)
  const [stale] = verificationMemory.verifiedCaseMemory({ ...state,
    evidences: state.evidences.map(item => item.id === 'settlement' ? { ...item, contentHash: 'v2' } : item) }, 'case')
  assert.equal(stale.calculation, undefined)
  assert.deepEqual(stale.sources, [source])
})

test('文书级黄灯只显示在有效核验快照，旧文书和已移除材料安全回退', () => {
  const legacy = workspace.certificates[0]
  assert.deepEqual(verificationMemory.verifiedDocumentDiagnostics(workspace, legacy), [])
  const omitted = { ...source, locator: '材料全文', quote: undefined }
  const warning = { code: 'A3' as const, verdict: 'warn' as const, reason: '卷内材料未列入证据清单。', sources: [omitted] }
  const current = { ...legacy, verification: { ...legacy.verification!, documentDiagnostics: [warning] } }
  assert.deepEqual(verificationMemory.verifiedDocumentDiagnostics(workspace, current), [warning])
  assert.deepEqual(verificationMemory.verifiedDocumentDiagnostics(workspace, { ...current, linkageStale: true }), [])
  assert.deepEqual(verificationMemory.verifiedDocumentDiagnostics({ ...workspace, evidences: [] }, current), [])
})

test('报告逐条展示有效的跨段依赖及检查结论，跳转只使用当前文书的声明', () => {
  const first = workspace.certificates[0]
  const fact = { ...first.verification!.declarations[0], id: 'fact', type: 'E-FACT' as const, verdict: 'miss' as const }
  const law = { ...fact, id: 'law', type: 'E-LAW' as const, quote: '合同法依据',
    location: { paragraphId: 'p2', paragraphIndex: 1, start: 0, end: 5 }, verdict: 'pending' as const,
    dependencies: [{ id: 'fact', check: 'B4' as const }, { id: 'missing', check: 'B4' as const }],
    checks: { B4: { outcome: 'pending' as const, reason: '依赖事实待核验。' } } }
  const document = { ...first, paragraphs: [...first.paragraphs, { id: 'p2', text: law.quote, verified: false }],
    verification: { ...first.verification!, declarations: [fact, law] } }
  const target = { id: 'law', certificateId: first.id, paragraphId: 'p2', quote: law.quote, start: 0, end: 5 } as ReviewElement
  const trigger = { id: 'fact', certificateId: first.id, paragraphId: 'p', quote: fact.quote, start: 0, end: 3 } as ReviewElement
  const elements = [trigger, target, { ...trigger, id: 'missing', certificateId: 'other' }]
  const rows = verificationMemory.verificationImpacts(document, elements)
  assert.deepEqual(rows.map(({ source, target: affected, check, reason, outcome }) => [source?.id, affected.id, check, reason, outcome]), [
    ['fact', 'law', 'B4', '依赖事实待核验。', 'pending'],
    [undefined, 'law', 'B4', '依赖事实待核验。', 'pending'],
  ])
  assert.deepEqual(verificationMemory.verificationImpacts({ ...document, linkageStale: true }, elements), [])
  const changed = { ...document, paragraphs: [document.paragraphs[0], { ...document.paragraphs[1], text: '已经改稿' }] }
  assert.deepEqual(verificationMemory.verificationImpacts(changed, elements), [])
})
