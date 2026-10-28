import { createHash } from 'node:crypto'
import { env } from './config/env.js'
import { getCurrentWorkspaceAccount, readWorkspace, writeWorkspace } from './store.js'
import { isCloudAiEnabled } from './integrations/cloud-ai.js'

// Session credentials stay in memory, never in case memory or the local database.
const credentials = new Map<string, string>()
const locks = new Map<string, Promise<unknown>>()
async function serialized<T>(caseId: string, task: () => Promise<T>) {
  const key = JSON.stringify([getCurrentWorkspaceAccount(), caseId])
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  locks.set(key, next)
  try { return await next } finally { if (locks.get(key) === next) locks.delete(key) }
}
export function rememberCaseAgentCredential(token: string | undefined) {
  const account = getCurrentWorkspaceAccount()
  if (account) {
    if (token?.trim()) credentials.set(account, token.trim())
    else credentials.delete(account)
  }
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
    throw Object.assign(new Error(envelope.error?.message || envelope.message || '积分校验失败，请检查账户余额。'), {
      code: envelope.error?.code, status: response.status,
    })
  }
  return envelope.data
}

export function chargedCaseAgentTask<T>(caseId: string, action: 'evidence_summary' | 'pleading_full', input: string, task: () => Promise<T>) {
  if (isCloudAiEnabled()) return serialized(caseId, task)
  return serialized(caseId, () => charge(caseId, action, input, task))
}

async function charge<T>(caseId: string, action: 'evidence_summary' | 'pleading_full', input: string, task: () => Promise<T>) {
  const profile = await cloud<{ user: { email: string } }>('profile')
  if (profile.user.email.toLowerCase() !== getCurrentWorkspaceAccount()) {
    throw new Error('登录账户与案件所属账户不一致，请重新登录。')
  }
  const workspace = await readWorkspace()
  const folder = workspace.cases.find(c => c.id === caseId)
  if (!folder) throw new Error('案件不存在。')
  const operation = `case-agent:${createHash('sha256').update(JSON.stringify([
    getCurrentWorkspaceAccount(), caseId, action, input, folder.agent?.task?.revision ?? 0,
  ])).digest('hex')}`
  folder.agent ??= { autoAnalyze: true }
  folder.agent.pendingCharges = [...(folder.agent.pendingCharges ?? []), { operation, entryId: '' }]
  await writeWorkspace(workspace)
  const consumed = await cloud<{ entry: { id: string }; pointsBalance: number }>('points/consume', {
    actionType: action, idempotencyKey: operation, workspaceId: caseId,
    resourceType: 'case_agent', resourceId: caseId, note: action === 'evidence_summary' ? '案件材料理解' : '案件主张与举证分析',
  })
  const record = await readWorkspace()
  const recordFolder = record.cases.find(c => c.id === caseId)
  const charge = recordFolder?.agent?.pendingCharges?.find(item => item.operation === operation)
  if (charge) { charge.entryId = consumed.entry.id; await writeWorkspace(record) }
  const clearCharge = async () => {
    const latest = await readWorkspace()
    const current = latest.cases.find(c => c.id === caseId)
    if (current?.agent) {
      current.agent.pendingCharges = (current.agent.pendingCharges ?? []).filter(item => item.operation !== operation)
      await writeWorkspace(latest)
    }
  }
  try {
    const result = await task()
    await clearCharge()
    return result
  } catch (error) {
    try {
      await cloud('points/refund', {
        refundOperationKey: `${operation}:refund`, sourceEntryId: consumed.entry.id, note: '案件分析失败退回',
      })
    } catch {
      const latest = await readWorkspace()
      const current = latest.cases.find(c => c.id === caseId)
      if (current) {
        current.agent ??= { autoAnalyze: true }
        current.agent.pendingRefunds = [...(current.agent.pendingRefunds ?? []),
          { operation, entryId: consumed.entry.id }]
        await writeWorkspace(latest)
      }
      throw new Error('案件分析未完成，积分退回待处理；恢复账户连接后会继续退回。')
    }
    await clearCharge()
    throw error
  }
}

export function settleCaseAgentRefunds(caseId: string) {
  return serialized(caseId, () => settleRefunds(caseId))
}

async function settleRefunds(caseId: string) {
  const workspace = await readWorkspace()
  const folder = workspace.cases.find(c => c.id === caseId)
  for (const refund of [...(folder?.agent?.pendingRefunds ?? []), ...(folder?.agent?.pendingCharges ?? [])]) {
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
  if (folder?.agent && (folder.agent.pendingRefunds?.length || folder.agent.pendingCharges?.length)) {
    folder.agent.pendingRefunds = []
    folder.agent.pendingCharges = []
    await writeWorkspace(workspace)
  }
}
