import { createHash } from 'node:crypto'
import { env } from './config/env.js'
import { getCurrentWorkspaceAccount, readWorkspace, writeWorkspace } from './store.js'
import { isCloudAiEnabled } from './integrations/cloud-ai.js'
import { runExclusiveWorkspaceMutation } from './infrastructure/workspace-lock.js'

// Session credentials stay in memory, never in case memory or the local database.
const credentials = new Map<string, string>()
const locks = new Map<string, Promise<unknown>>()
// 正在执行中的扣费：结算流程不能把这些扣费提前退回，否则任务成功后会重复退款。
const inFlightCharges = new Set<string>()
async function serialized<T>(caseId: string, task: () => Promise<T>) {
  const key = JSON.stringify([getCurrentWorkspaceAccount(), caseId])
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  locks.set(key, next)
  try { return await next } finally { if (locks.get(key) === next) locks.delete(key) }
}

function chargeKey(caseId: string, operation: string) {
  return JSON.stringify([getCurrentWorkspaceAccount(), caseId, operation])
}
export function rememberCaseAgentCredential(token: string | undefined) {
  const account = getCurrentWorkspaceAccount()
  // 缺少凭据请求头的请求不代表退出登录：只有真正带上凭据时才更新，避免凭据被无关请求清空。
  if (account && token?.trim()) credentials.set(account, token.trim())
}
export function forgetCaseAgentCredential(account?: string | null) {
  const target = (account ?? getCurrentWorkspaceAccount())?.trim().toLowerCase()
  if (target) credentials.delete(target)
}

async function cloud<T>(endpoint: string, body?: unknown): Promise<T> {
  const account = getCurrentWorkspaceAccount()
  const token = account ? credentials.get(account) : undefined
  if (!token) throw new Error('请重新登录官网账户后继续自动梳理案件。')
  if (!env.CLOUD_API_BASE_URL) throw new Error('账户服务尚未配置，自动分析已暂停。')
  const response = await fetch(`${env.CLOUD_API_BASE_URL.replace(/\/$/, '')}/api/account/${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  }).catch(() => { throw new Error('当前无法连接账户服务，自动分析已暂停。') })
  const envelope = await response.json() as { data: T; message?: string; error?: { message?: string; code?: string } }
  if (!response.ok) {
    // 上游判定登录态失效时丢弃本地凭据，避免后续一直用失效凭据重试。
    if (response.status === 401) {
      forgetCaseAgentCredential()
    }
    throw Object.assign(new Error(envelope.error?.message || envelope.message || '积分校验失败，请检查账户余额。'), {
      code: envelope.error?.code, status: response.status,
    })
  }
  return envelope.data
}

export function chargedCaseAgentTask<T>(caseId: string, action: 'evidence_summary' | 'pleading_full', input: string, task: () => Promise<T>) {
  // 云端网关模式下计费由网关完成，任务不再被案件级锁串行，
  // 这样同一案件的多份材料可以并发理解。
  if (isCloudAiEnabled()) return task()
  return chargedTask(caseId, action, input, task)
}

// 扣费登记与任务执行分离：扣费在案件级锁内串行完成，
// 耗时的模型理解放在锁外执行，避免整案理解被压成串行。
async function chargedTask<T>(caseId: string, action: 'evidence_summary' | 'pleading_full', input: string, task: () => Promise<T>) {
  const charged = await serialized(caseId, () => startCharge(caseId, action, input))
  try {
    const result = await task()
    await serialized(caseId, () => clearCharge(caseId, charged.operation))
    return result
  } catch (error) {
    await serialized(caseId, () => refundCharge(caseId, charged))
    throw error
  } finally {
    inFlightCharges.delete(chargeKey(caseId, charged.operation))
  }
}

async function startCharge(caseId: string, action: 'evidence_summary' | 'pleading_full', input: string) {
  const profile = await cloud<{ user: { email: string } }>('profile')
  if (profile.user.email.toLowerCase() !== getCurrentWorkspaceAccount()) {
    throw new Error('登录账户与案件所属账户不一致，请重新登录。')
  }
  const operation = await runExclusiveWorkspaceMutation(async () => {
    const workspace = await readWorkspace()
    const folder = workspace.cases.find(c => c.id === caseId)
    if (!folder) throw new Error('案件不存在。')
    const operation = `case-agent:${createHash('sha256').update(JSON.stringify([
      getCurrentWorkspaceAccount(), caseId, action, input, folder.agent?.task?.revision ?? 0,
    ])).digest('hex')}`
    folder.agent ??= { autoAnalyze: true }
    folder.agent.pendingCharges = [...(folder.agent.pendingCharges ?? []), { operation, entryId: '' }]
    await writeWorkspace(workspace)
    // 标记为执行中，避免结算流程把仍在跑的扣费提前退回。
    inFlightCharges.add(chargeKey(caseId, operation))
    return operation
  })
  let consumed: { entry: { id: string }; pointsBalance: number }
  try {
    consumed = await cloud<{ entry: { id: string }; pointsBalance: number }>('points/consume', {
      actionType: action, idempotencyKey: operation, workspaceId: caseId,
      resourceType: 'case_agent', resourceId: caseId, note: action === 'evidence_summary' ? '案件材料理解' : '案件主张与举证分析',
    })
  } catch (error) {
    // 扣费未成功时释放执行中标记，让结算流程可以正常退回这笔挂起扣费。
    inFlightCharges.delete(chargeKey(caseId, operation))
    throw error
  }
  await runExclusiveWorkspaceMutation(async () => {
    const record = await readWorkspace()
    const recordFolder = record.cases.find(c => c.id === caseId)
    const charge = recordFolder?.agent?.pendingCharges?.find(item => item.operation === operation)
    if (charge) { charge.entryId = consumed.entry.id; await writeWorkspace(record) }
  })
  return { operation, entryId: consumed.entry.id }
}

async function clearCharge(caseId: string, operation: string) {
  await runExclusiveWorkspaceMutation(async () => {
    const latest = await readWorkspace()
    const current = latest.cases.find(c => c.id === caseId)
    if (current?.agent) {
      current.agent.pendingCharges = (current.agent.pendingCharges ?? []).filter(item => item.operation !== operation)
      await writeWorkspace(latest)
    }
  })
}

async function refundCharge(caseId: string, charged: { operation: string; entryId: string }) {
  try {
    await cloud('points/refund', {
      refundOperationKey: `${charged.operation}:refund`, sourceEntryId: charged.entryId, note: '案件分析失败退回',
    })
  } catch {
    await runExclusiveWorkspaceMutation(async () => {
      const latest = await readWorkspace()
      const current = latest.cases.find(c => c.id === caseId)
      if (current) {
        current.agent ??= { autoAnalyze: true }
        current.agent.pendingRefunds = [...(current.agent.pendingRefunds ?? []),
          { operation: charged.operation, entryId: charged.entryId }]
        await writeWorkspace(latest)
      }
    })
    throw new Error('案件分析未完成，积分退回待处理；恢复账户连接后会继续退回。')
  }
  await clearCharge(caseId, charged.operation)
}

export function settleCaseAgentRefunds(caseId: string) {
  return serialized(caseId, () => settleRefunds(caseId))
}

async function settleRefunds(caseId: string) {
  await runExclusiveWorkspaceMutation(async () => {
    const workspace = await readWorkspace()
    const folder = workspace.cases.find(c => c.id === caseId)
    for (const refund of [...(folder?.agent?.pendingRefunds ?? []), ...(folder?.agent?.pendingCharges ?? [])]) {
      // 正在执行中的扣费不能在此处退回，否则任务成功后会出现重复退款。
      if (inFlightCharges.has(chargeKey(caseId, refund.operation))) continue
      try {
        await cloud('points/refund', {
          refundOperationKey: `${refund.operation}:refund`,
          ...(refund.entryId ? { sourceEntryId: refund.entryId } : { sourceOperationKey: refund.operation }),
          note: '案件分析失败退回',
        })
      } catch (error) {
        if (refund.entryId || (error as { code?: string }).code !== 'POINT_REFUND_SOURCE_NOT_FOUND') throw error
      }
    }
    if (folder?.agent) {
      // 仍在执行的扣费要保留，等任务结束后再清理。
      const pendingRefunds = (folder.agent.pendingRefunds ?? []).filter(item => inFlightCharges.has(chargeKey(caseId, item.operation)))
      const pendingCharges = (folder.agent.pendingCharges ?? []).filter(item => inFlightCharges.has(chargeKey(caseId, item.operation)))
      const total = (folder.agent.pendingRefunds?.length ?? 0) + (folder.agent.pendingCharges?.length ?? 0)
      if (pendingRefunds.length + pendingCharges.length !== total) {
        folder.agent.pendingRefunds = pendingRefunds
        folder.agent.pendingCharges = pendingCharges
        await writeWorkspace(workspace)
      }
    }
  })
}
