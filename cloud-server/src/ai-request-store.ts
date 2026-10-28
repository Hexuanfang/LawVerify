import type { AuthenticatedActor } from './commercial/types.js'
import { isDatabaseEnabled, query } from './infrastructure/postgres.js'
import { refundPointAction } from './point-service.js'
import { AppError } from './core/app-error.js'

export async function beginAiRequest(id: string, actor: AuthenticatedActor) {
  if (!isDatabaseEnabled()) throw new AppError('智能分析需要持久化账务数据库。', 503, 'AI_DATABASE_REQUIRED')
  const result = await query(
    `INSERT INTO ai_gateway_requests(id, organization_id, user_id, actor, status, consumption_key)
     VALUES($1,$2,$3,$4::jsonb,'running',$5) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [id, actor.organizationId, actor.userId, JSON.stringify(actor), `ai:${id}`],
  )
  if (!result.rowCount) throw new AppError('此请求已经处理，请使用新的请求编号。', 409, 'AI_REQUEST_DUPLICATE')
}
export async function updateAiRequest(id: string, status: 'running' | 'succeeded' | 'refund_pending' | 'refunded', entryId?: string) {
  await query(`UPDATE ai_gateway_requests SET status=$2, entry_id=COALESCE($3,entry_id), updated_at=NOW() WHERE id=$1`,
    [id, status, entryId ?? null])
}
export async function reconcileAiRequests() {
  if (!isDatabaseEnabled()) return
  const candidates = await query<{ id: string; actor: AuthenticatedActor; consumption_key: string }>(
    `SELECT id, actor, consumption_key FROM ai_gateway_requests
     WHERE status='refund_pending' OR (status='running' AND updated_at < NOW() - INTERVAL '15 minutes')
     ORDER BY updated_at LIMIT 100`,
  )
  for (const item of candidates.rows) {
    try {
      await refundPointAction(item.actor, {
        sourceOperationKey: item.consumption_key, refundOperationKey: `ai-refund:${item.id}`, note: '未完成智能分析退回',
      })
      await updateAiRequest(item.id, 'refunded')
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'POINT_REFUND_SOURCE_NOT_FOUND' || code === 'POINT_REFUND_ALREADY_PROCESSED') {
        await updateAiRequest(item.id, 'refunded')
      } else console.error('AI reconciliation pending:', item.id)
    }
  }
}
