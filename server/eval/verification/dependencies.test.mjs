import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDeclarationDependencies } from '../../src/intelligence/verification/dependencies.ts'

const item = (id, type, verdict, sentenceIndex = 0, checks = {}) => ({ id, type, verdict, checks, reason: '原结论', location: { paragraphId: 'p', sentenceIndex }, sources: [] })

test('同句事实不通过重开适配、类案降近似；B2 失效不能被级联掩盖', () => {
  const input = [item('fact', 'E-FACT', 'miss'), item('law', 'E-LAW', 'fail', 0, { B2: { outcome: 'fail', reason: '版本失效' } }),
    item('citation', 'E-CASE', 'pass'), item('unrelated', 'E-CASE', 'pass', 1)]
  const [fact, law, citation, unrelated] = applyDeclarationDependencies(input)
  assert.strictEqual(fact, input[0])
  assert.equal(law.verdict, 'fail')
  assert.equal(law.checks.B4.outcome, 'pending')
  assert.deepEqual(citation.dependencies, [{ id: 'fact', check: 'C4' }, { id: 'law', check: 'C6' }])
  assert.equal(citation.verdict, 'warn')
  assert.equal(citation.checks.C6.outcome, 'warn')
  assert.equal(unrelated.verdict, 'pass')
  assert.equal(input[2].verdict, 'pass')
})
