import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDraftPosition } from '../../src/intelligence/verification/draft-policy.ts'

test('起草只接受已确认且一致的诉讼角色；生成中立场变更也不写回', () => {
  assert.throws(() => assertDraftPosition(undefined, 'plaintiff'), { code: 'DRAFT_POSITION_REQUIRED' })
  const position = { role: 'defendant', confirmedAt: '2026-11-18T12:00:00Z', version: 2 }
  assert.throws(() => assertDraftPosition(position, 'plaintiff'), { code: 'DRAFT_POSITION_REQUIRED' })
  assert.throws(() => assertDraftPosition(position, 'defendant', 1), { code: 'DRAFT_POSITION_CHANGED' })
  assert.equal(assertDraftPosition(position, 'defendant'), 2)
})
