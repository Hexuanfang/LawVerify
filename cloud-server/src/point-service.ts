import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

import type { AuthenticatedActor } from './commercial/types.js'
import { AppError } from './core/app-error.js'
import { readDevStore, updateDevStore } from './infrastructure/dev-store.js'
import { getPool, isDatabaseEnabled, query } from './infrastructure/postgres.js'
import { pointPolicies } from './mock-data.js'
import type { PointActionType, PointLedgerEntryType, PointPolicy } from './types.js'

type QuotePointActionInput = {
  actionType: PointActionType
  units?: number
}

type ConsumePointActionInput = QuotePointActionInput & {
  idempotencyKey: string
  workspaceId?: string
  resourceType?: string
  resourceId?: string
  note?: string
}

type RefundPointActionInput = {
  refundOperationKey: string
  sourceOperationKey?: string
  sourceEntryId?: string
  note?: string
}

type PointLedgerRow = {
  id: string
  entry_type: PointLedgerEntryType
  action_type: PointActionType | null
  operation_key: string | null
  change_points: number
  note: string
  created_at: string
}

function normalizeUnits(units?: number) {
  const value = Number.isFinite(units) ? Math.trunc(Number(units)) : 1
  if (value <= 0) {
    throw new AppError('计费数量必须大于 0。', 400, 'POINTS_UNITS_INVALID')
  }

  if (value > 500) {
    throw new AppError('单次计费数量过大，请拆分任务后重试。', 400, 'POINTS_UNITS_TOO_LARGE')
  }

  return value
}

export function getPointPolicy(actionType: PointActionType): PointPolicy {
  const policy = pointPolicies.find((p) => p.actionType === actionType)
  if (!policy) {
    throw new AppError('未知的计费操作类型。', 400, 'POINTS_ACTION_INVALID')
  }
  return policy
}

function buildConsumptionNote(policy: PointPolicy, units: number, note?: string) {
  if (note?.trim()) {
    return note.trim()
  }

  return units === 1
    ? `${policy.label}消耗`
    : `${policy.label}消耗 (${units} ${policy.unitLabel})`
}

function buildRefundNote(sourceNote: string, note?: string) {
  if (note?.trim()) {
    return note.trim()
  }

  return `${sourceNote}退款补回`
}

async function getStoredPointBalance(actor: AuthenticatedActor, client?: PoolClient) {
  const executor = client ?? getPool()
  await executor.query(
    `
      INSERT INTO point_accounts (organization_id, user_id, balance_points)
      VALUES ($1, $2, 0)
      ON CONFLICT (organization_id, user_id) DO NOTHING
    `,
    [actor.organizationId, actor.userId],
  )

  const result = await executor.query<{ balance_points: number }>(
    `
      SELECT balance_points
      FROM point_accounts
      WHERE organization_id = $1 AND user_id = $2
      LIMIT 1
    `,
    [actor.organizationId, actor.userId],
  )

  return result.rows[0]?.balance_points ?? 0
}

async function getDevPointBalance(actor: AuthenticatedActor) {
  const store = await readDevStore()
  const account = store.pointAccounts.find((item) => item.organizationId === actor.organizationId && item.userId === actor.userId)
  return account?.balancePoints ?? 0
}

async function findStoredLedgerByOperationKey(actor: AuthenticatedActor, operationKey: string, client?: PoolClient) {
  const executor = client ?? getPool()
  const result = await executor.query<PointLedgerRow>(
    `
      SELECT
        id,
        entry_type,
        action_type,
        operation_key,
        change_points,
        note,
        created_at
      FROM point_ledger_entries
      WHERE organization_id = $1
        AND commercial_user_id = $2
        AND operation_key = $3
      LIMIT 1
    `,
    [actor.organizationId, actor.userId, operationKey],
  )

  return result.rows[0] ?? null
}

async function findStoredLedgerForRefund(actor: AuthenticatedActor, input: RefundPointActionInput, client?: PoolClient) {
  const executor = client ?? getPool()

  if (input.sourceEntryId?.trim()) {
    const result = await executor.query<PointLedgerRow>(
      `
        SELECT
          id,
          entry_type,
          action_type,
          operation_key,
          change_points,
          note,
          created_at
        FROM point_ledger_entries
        WHERE organization_id = $1
          AND commercial_user_id = $2
          AND id = $3
        LIMIT 1
      `,
      [actor.organizationId, actor.userId, input.sourceEntryId.trim()],
    )

    return result.rows[0] ?? null
  }

  if (input.sourceOperationKey?.trim()) {
    return findStoredLedgerByOperationKey(actor, input.sourceOperationKey.trim(), client)
  }

  throw new AppError('退款需要指定来源消费记录。', 400, 'POINT_REFUND_SOURCE_REQUIRED')
}

export async function listPointPolicies() {
  return {
    items: pointPolicies,
  }
}

export async function quotePointAction(actor: AuthenticatedActor, input: QuotePointActionInput) {
  const policy = getPointPolicy(input.actionType)
  const units = normalizeUnits(input.units)
  const requiredPoints = policy.pointsPerUnit * units
  const pointsBalance = isDatabaseEnabled()
    ? await getStoredPointBalance(actor)
    : await getDevPointBalance(actor)

  return {
    policy,
    units,
    requiredPoints,
    pointsBalance,
    pointsSufficient: pointsBalance >= requiredPoints,
  }
}

export async function consumePointAction(actor: AuthenticatedActor, input: ConsumePointActionInput) {
  const idempotencyKey = input.idempotencyKey.trim()
  if (!idempotencyKey) {
    throw new AppError('缺少幂等键，无法安全扣减积分。', 400, 'POINTS_IDEMPOTENCY_REQUIRED')
  }

  const quote = await quotePointAction(actor, input)

  if (!isDatabaseEnabled()) {
    return updateDevStore((store) => {
      let account = store.pointAccounts.find((item) => item.organizationId === actor.organizationId && item.userId === actor.userId)
      if (!account) {
        account = {
          organizationId: actor.organizationId,
          userId: actor.userId,
          balancePoints: 0,
        }
        store.pointAccounts.push(account)
      }

      const existing = store.pointLedgerEntries.find((item) => (
        item.organizationId === actor.organizationId
        && item.userId === actor.userId
        && item.operationKey === idempotencyKey
      ))

      if (existing) {
        return {
          entry: {
            id: existing.id,
            createdAt: existing.createdAt,
            description: existing.note,
            delta: existing.changePoints,
            balanceAfter: account.balancePoints,
            entryType: existing.entryType,
            actionType: existing.actionType,
            operationKey: existing.operationKey,
          },
          policy: quote.policy,
          units: quote.units,
          requiredPoints: quote.requiredPoints,
          pointsBalance: account.balancePoints,
          duplicated: true,
        }
      }

      if (account.balancePoints <= 0) {
        throw new AppError('当前积分不足，请先充值后再继续。', 400, 'POINTS_INSUFFICIENT', {
          requiredPoints: quote.requiredPoints,
          pointsBalance: account.balancePoints,
        })
      }

      const createdAt = new Date().toISOString()
      account.balancePoints -= quote.requiredPoints
      const entryId = `point-${randomUUID()}`
      store.pointLedgerEntries.unshift({
        id: entryId,
        organizationId: actor.organizationId,
        userId: actor.userId,
        entryType: 'consume',
        actionType: quote.policy.actionType,
        operationKey: idempotencyKey,
        relatedEntryId: undefined,
        changePoints: -quote.requiredPoints,
        note: buildConsumptionNote(quote.policy, quote.units, input.note),
        metadata: {
          units: quote.units,
          workspaceId: input.workspaceId?.trim() || undefined,
          resourceType: input.resourceType?.trim() || undefined,
          resourceId: input.resourceId?.trim() || undefined,
        },
        createdAt,
      })

      return {
        entry: {
          id: entryId,
          createdAt,
          description: buildConsumptionNote(quote.policy, quote.units, input.note),
          delta: -quote.requiredPoints,
          balanceAfter: account.balancePoints,
          entryType: 'consume' as const,
          actionType: quote.policy.actionType,
          operationKey: idempotencyKey,
        },
        policy: quote.policy,
        units: quote.units,
        requiredPoints: quote.requiredPoints,
        pointsBalance: account.balancePoints,
        duplicated: false,
      }
    })
  }

  const existing = await findStoredLedgerByOperationKey(actor, idempotencyKey)
  if (existing) {
    return {
      entry: {
        id: existing.id,
        createdAt: existing.created_at,
        description: existing.note,
        delta: existing.change_points,
        balanceAfter: await getStoredPointBalance(actor),
        entryType: existing.entry_type,
        actionType: existing.action_type ?? undefined,
        operationKey: existing.operation_key ?? undefined,
      },
      policy: quote.policy,
      units: quote.units,
      requiredPoints: Math.abs(existing.change_points),
      pointsBalance: await getStoredPointBalance(actor),
      duplicated: true,
    }
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `
        INSERT INTO point_accounts (organization_id, user_id, balance_points)
        VALUES ($1, $2, 0)
        ON CONFLICT (organization_id, user_id) DO NOTHING
      `,
      [actor.organizationId, actor.userId],
    )

    const accountResult = await client.query<{ balance_points: number }>(
      `
        SELECT balance_points
        FROM point_accounts
        WHERE organization_id = $1 AND user_id = $2
        FOR UPDATE
      `,
      [actor.organizationId, actor.userId],
    )

    const pointsBalance = accountResult.rows[0]?.balance_points ?? 0
    if (pointsBalance <= 0) {
      throw new AppError('当前积分不足，请先充值后再继续。', 400, 'POINTS_INSUFFICIENT', {
        requiredPoints: quote.requiredPoints,
        pointsBalance,
      })
    }

    const createdAt = new Date().toISOString()
    const entryResult = await client.query<PointLedgerRow>(
      `
        INSERT INTO point_ledger_entries (
          organization_id,
          commercial_user_id,
          workspace_user_id,
          workspace_user_email,
          workspace_user_name,
          entry_type,
          action_type,
          operation_key,
          change_points,
          note,
          metadata,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, 'consume', $6, $7, $8, $9, $10::jsonb, $11)
        RETURNING
          id,
          entry_type,
          action_type,
          operation_key,
          change_points,
          note,
          created_at
      `,
      [
        actor.organizationId,
        actor.userId,
        actor.userId,
        actor.email,
        actor.email,
        quote.policy.actionType,
        idempotencyKey,
        -quote.requiredPoints,
        buildConsumptionNote(quote.policy, quote.units, input.note),
        JSON.stringify({
          units: quote.units,
          workspaceId: input.workspaceId?.trim() || undefined,
          resourceType: input.resourceType?.trim() || undefined,
          resourceId: input.resourceId?.trim() || undefined,
        }),
        createdAt,
      ],
    )

    await client.query(
      `
        UPDATE point_accounts
        SET
          balance_points = balance_points - $3,
          updated_at = NOW()
        WHERE organization_id = $1 AND user_id = $2
      `,
      [actor.organizationId, actor.userId, quote.requiredPoints],
    )

    await client.query('COMMIT')

    return {
      entry: {
        id: entryResult.rows[0].id,
        createdAt: entryResult.rows[0].created_at,
        description: entryResult.rows[0].note,
        delta: entryResult.rows[0].change_points,
        balanceAfter: pointsBalance - quote.requiredPoints,
        entryType: entryResult.rows[0].entry_type,
        actionType: entryResult.rows[0].action_type ?? undefined,
        operationKey: entryResult.rows[0].operation_key ?? undefined,
      },
      policy: quote.policy,
      units: quote.units,
      requiredPoints: quote.requiredPoints,
      pointsBalance: pointsBalance - quote.requiredPoints,
      duplicated: false,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function refundPointAction(actor: AuthenticatedActor, input: RefundPointActionInput) {
  const refundOperationKey = input.refundOperationKey.trim()
  if (!refundOperationKey) {
    throw new AppError('缺少退款幂等键。', 400, 'POINT_REFUND_OPERATION_REQUIRED')
  }

  if (!isDatabaseEnabled()) {
    return updateDevStore((store) => {
      let account = store.pointAccounts.find((item) => item.organizationId === actor.organizationId && item.userId === actor.userId)
      if (!account) {
        account = {
          organizationId: actor.organizationId,
          userId: actor.userId,
          balancePoints: 0,
        }
        store.pointAccounts.push(account)
      }

      const existingRefund = store.pointLedgerEntries.find((item) => (
        item.organizationId === actor.organizationId
        && item.userId === actor.userId
        && item.operationKey === refundOperationKey
      ))

      if (existingRefund) {
        return {
          entry: {
            id: existingRefund.id,
            createdAt: existingRefund.createdAt,
            description: existingRefund.note,
            delta: existingRefund.changePoints,
            balanceAfter: account.balancePoints,
            entryType: existingRefund.entryType,
            actionType: existingRefund.actionType,
            operationKey: existingRefund.operationKey,
          },
          pointsBalance: account.balancePoints,
          duplicated: true,
        }
      }

      const source = store.pointLedgerEntries.find((item) => (
        item.organizationId === actor.organizationId
        && item.userId === actor.userId
        && (
          (input.sourceEntryId?.trim() && item.id === input.sourceEntryId.trim())
          || (input.sourceOperationKey?.trim() && item.operationKey === input.sourceOperationKey.trim())
        )
      ))

      if (!source || source.entryType !== 'consume') {
        throw new AppError('未找到可退款的积分消费记录。', 404, 'POINT_REFUND_SOURCE_NOT_FOUND')
      }

      const existingSourceRefund = store.pointLedgerEntries.find((item) => item.relatedEntryId === source.id && item.entryType === 'refund')
      if (existingSourceRefund) {
        throw new AppError('该积分消费记录已完成退款。', 409, 'POINT_REFUND_ALREADY_PROCESSED')
      }

      const createdAt = new Date().toISOString()
      const refundPoints = Math.abs(source.changePoints)
      account.balancePoints += refundPoints
      const entryId = `point-${randomUUID()}`
      store.pointLedgerEntries.unshift({
        id: entryId,
        organizationId: actor.organizationId,
        userId: actor.userId,
        entryType: 'refund',
        actionType: source.actionType,
        operationKey: refundOperationKey,
        relatedEntryId: source.id,
        changePoints: refundPoints,
        note: buildRefundNote(source.note, input.note),
        metadata: {
          sourceEntryId: source.id,
          sourceOperationKey: source.operationKey,
        },
        createdAt,
      })

      return {
        entry: {
          id: entryId,
          createdAt,
          description: buildRefundNote(source.note, input.note),
          delta: refundPoints,
          balanceAfter: account.balancePoints,
          entryType: 'refund' as const,
          actionType: source.actionType,
          operationKey: refundOperationKey,
        },
        pointsBalance: account.balancePoints,
        duplicated: false,
      }
    })
  }

  const existingRefund = await findStoredLedgerByOperationKey(actor, refundOperationKey)
  if (existingRefund) {
    const pointsBalance = await getStoredPointBalance(actor)
    return {
      entry: {
        id: existingRefund.id,
        createdAt: existingRefund.created_at,
        description: existingRefund.note,
        delta: existingRefund.change_points,
        balanceAfter: pointsBalance,
        entryType: existingRefund.entry_type,
        actionType: existingRefund.action_type ?? undefined,
        operationKey: existingRefund.operation_key ?? undefined,
      },
      pointsBalance,
      duplicated: true,
    }
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const source = await findStoredLedgerForRefund(actor, input, client)
    if (!source || source.entry_type !== 'consume') {
      throw new AppError('未找到可退款的积分消费记录。', 404, 'POINT_REFUND_SOURCE_NOT_FOUND')
    }

    const existingSourceRefund = await client.query<{ id: string }>(
      `
        SELECT id
        FROM point_ledger_entries
        WHERE organization_id = $1
          AND commercial_user_id = $2
          AND related_entry_id = $3
          AND entry_type = 'refund'
        LIMIT 1
      `,
      [actor.organizationId, actor.userId, source.id],
    )

    if (existingSourceRefund.rowCount) {
      throw new AppError('该积分消费记录已完成退款。', 409, 'POINT_REFUND_ALREADY_PROCESSED')
    }

    const currentBalance = await getStoredPointBalance(actor, client)
    const refundPoints = Math.abs(source.change_points)
    const createdAt = new Date().toISOString()
    const entryResult = await client.query<PointLedgerRow>(
      `
        INSERT INTO point_ledger_entries (
          organization_id,
          commercial_user_id,
          workspace_user_id,
          workspace_user_email,
          workspace_user_name,
          entry_type,
          action_type,
          operation_key,
          related_entry_id,
          change_points,
          note,
          metadata,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, 'refund', $6, $7, $8, $9, $10, $11::jsonb, $12)
        RETURNING
          id,
          entry_type,
          action_type,
          operation_key,
          change_points,
          note,
          created_at
      `,
      [
        actor.organizationId,
        actor.userId,
        actor.userId,
        actor.email,
        actor.email,
        source.action_type,
        refundOperationKey,
        source.id,
        refundPoints,
        buildRefundNote(source.note, input.note),
        JSON.stringify({
          sourceEntryId: source.id,
          sourceOperationKey: source.operation_key,
        }),
        createdAt,
      ],
    )

    await client.query(
      `
        UPDATE point_accounts
        SET
          balance_points = balance_points + $3,
          updated_at = NOW()
        WHERE organization_id = $1 AND user_id = $2
      `,
      [actor.organizationId, actor.userId, refundPoints],
    )

    await client.query('COMMIT')

    return {
      entry: {
        id: entryResult.rows[0].id,
        createdAt: entryResult.rows[0].created_at,
        description: entryResult.rows[0].note,
        delta: entryResult.rows[0].change_points,
        balanceAfter: currentBalance + refundPoints,
        entryType: entryResult.rows[0].entry_type,
        actionType: entryResult.rows[0].action_type ?? undefined,
        operationKey: entryResult.rows[0].operation_key ?? undefined,
      },
      pointsBalance: currentBalance + refundPoints,
      duplicated: false,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
