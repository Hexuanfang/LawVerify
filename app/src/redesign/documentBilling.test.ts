import test from 'node:test'
import assert from 'node:assert/strict'
import { runDocumentAction } from './documentBilling.ts'

function fixture() {
  const events: string[] = []
  return {
    events,
    billing: {
      charge: async () => { events.push('charge'); return { entry: { id: 'entry', description: '文书生成' } } },
      refund: async (id: string, key: string, note: string) => { events.push(`refund:${id}:${key}:${note}`) },
      refresh: () => { events.push('refresh') },
    },
  }
}
const options = { cloudBilling: false, token: 'test-session', operationKey: 'operation' }

test('客户端计费先扣费，任务成功后刷新余额', async () => {
  const { events, billing } = fixture()
  assert.equal(await runDocumentAction(options, billing, async () => { events.push('task'); return 'saved' }), 'saved')
  assert.deepEqual(events, ['charge', 'task', 'refresh'])
})
test('云端计费由服务端执行，任务结束刷新余额', async () => {
  const { events, billing } = fixture()
  await runDocumentAction({ ...options, cloudBilling: true }, billing, async () => { events.push('task') })
  assert.deepEqual(events, ['task', 'refresh'])
})
test('任务失败按同一操作键退款并保留原始错误', async () => {
  const { events, billing } = fixture()
  const error = new Error('模型失败')
  await assert.rejects(runDocumentAction(options, billing, async () => { throw error }), value => value === error)
  assert.deepEqual(events, ['charge', 'refund:entry:operation:refund:文书生成失败补回', 'refresh'])
})
test('扣费失败时不执行生成和退款', async () => {
  const { events, billing } = fixture()
  billing.charge = async () => { events.push('charge'); throw new Error('积分不足') }
  await assert.rejects(runDocumentAction(options, billing, async () => { events.push('task') }), /积分不足/)
  assert.deepEqual(events, ['charge', 'refresh'])
})
test('退款失败仍保留任务错误并刷新余额', async () => {
  const { events, billing } = fixture()
  billing.refund = async () => { throw new Error('退款请求失败') }
  await assert.rejects(runDocumentAction(options, billing, async () => { throw new Error('原始错误') }), /原始错误/)
  assert.deepEqual(events, ['charge', 'refresh'])
})
test('未绑定云端会话时阻止计费任务', async () => {
  const { events, billing } = fixture()
  await assert.rejects(runDocumentAction({ ...options, token: null }, billing, async () => { events.push('task') }), /官网账户/)
  assert.deepEqual(events, [])
})

test('扣费完成后会话变化时阻止生成并退回原扣费记录', async () => {
  const { events, billing } = fixture()
  let current = true
  billing.charge = async () => { events.push('charge'); current = false; return { entry: { id: 'entry', description: '文书生成' } } }
  await assert.rejects(runDocumentAction({ ...options, isCurrent: () => current }, billing, async () => { events.push('task') }), /会话/)
  assert.deepEqual(events, ['charge', 'refund:entry:operation:refund:文书生成失败补回', 'refresh'])
})
