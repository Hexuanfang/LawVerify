import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adoptAssistantCandidate, discardAssistantCandidate, rememberAssistantCandidate } from '../src/assistant/candidates.ts'
import { runWithWorkspaceAccount } from '../src/store.ts'

test('候选只允许同账号、案件和文书的明确确认，重复采纳只执行一次', async () => {
  const target = { caseId: 'case-a', certificateId: 'document-a' }
  let writes = 0
  const candidateId = runWithWorkspaceAccount('assistant-a@test.invalid', () => rememberAssistantCandidate(target, async () => {
    writes++
    return { certificateId: 'document-a' }
  }))
  const request = { ...target, candidateId, confirmed: true }
  await runWithWorkspaceAccount('assistant-b@test.invalid', () => assert.rejects(adoptAssistantCandidate(request), /候选/))
  await runWithWorkspaceAccount('assistant-a@test.invalid', async () => {
    await assert.rejects(adoptAssistantCandidate({ ...request, confirmed: false }), /确认/)
    await assert.rejects(adoptAssistantCandidate({ ...request, certificateId: 'document-b' }), /候选/)
    assert.equal(writes, 0)
    assert.deepEqual(await Promise.all([adoptAssistantCandidate(request), adoptAssistantCandidate(request)]), [
      { certificateId: 'document-a' }, { certificateId: 'document-a' },
    ])
    assert.equal(writes, 1)
  })
})

test('放弃候选后不能采纳', async () => {
  await runWithWorkspaceAccount('assistant-a@test.invalid', async () => {
    const target = { caseId: 'case-a' }
    const candidateId = rememberAssistantCandidate(target, async () => assert.fail('已放弃候选不能写入'))
    discardAssistantCandidate(candidateId)
    await assert.rejects(adoptAssistantCandidate({ ...target, candidateId, confirmed: true }), /候选/)
  })
})
