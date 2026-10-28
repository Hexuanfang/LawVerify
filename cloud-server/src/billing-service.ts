import { randomUUID } from 'node:crypto'
import { rewardDevReferral, rewardStoredReferral } from './referral-service.js'
import type { PoolClient } from 'pg'

import type { AuthenticatedActor } from './commercial/types.js'
import { AppError } from './core/app-error.js'
import { createGatewayRechargeOrder, getPaymentProviderStatuses, queryGatewayRechargeOrder } from './integrations/payment.js'
import { readDevStore, updateDevStore } from './infrastructure/dev-store.js'
import { getPool, isDatabaseEnabled, query } from './infrastructure/postgres.js'
import { accountSummary, billingOrders, billingPackages, usageSummary } from './mock-data.js'
import type { BillingOrder, BillingPackage, PointLedgerEntry, UsageMetric } from './types.js'

type PaymentOrderRow = {
  organization_id?: string | null
  commercial_user_id?: string | null
  workspace_user_id?: string
  workspace_user_email?: string | null
  workspace_user_name?: string | null
  id: string
  package_id: string
  channel: BillingOrder['channel']
  title: string
  description: string
  amount_fen: number
  points: number
  out_trade_no: string
  status: BillingOrder['status']
  qr_code_content: string | null
  payment_url: string | null
  provider_order_id: string | null
  provider_message: string | null
  point_log_id: string | null
  created_at: string
  updated_at: string
  expires_at: string
  paid_at: string | null
}

type PointLedgerRow = {
  id: string
  entry_type?: PointLedgerEntry['entryType']
  action_type?: PointLedgerEntry['actionType'] | null
  operation_key?: string | null
  change_points: number
  note: string
  created_at: string
}

type PaymentCallbackInput = {
  provider: 'alipay' | 'wechat'
  outTradeNo?: string
  providerOrderId?: string
  status: BillingOrder['status']
  paidAt?: string
  providerMessage?: string
  payload: Record<string, unknown>
}

type BillingIdentity = {
  workspaceUserId: string
  commercialUserId: string | null
  organizationId: string | null
  email: string
  name: string
}

type BillingAccountSummaryRow = {
  user_id: string
  display_name: string
  email: string
  balance_points: number | null
  tier_name: string | null
  subscription_expires_at: string | null
}

const DEFAULT_WORKSPACE_USER_ID = 'desktop-user-demo'
const inMemoryOrders: BillingOrder[] = [...billingOrders]
const inMemoryPointLedger: PointLedgerEntry[] = []

function getRechargePackage(packageId: string) {
  const target = billingPackages.find((item) => item.id === packageId)
  if (!target) {
    throw new AppError('充值套餐不存在。', 404, 'RECHARGE_PACKAGE_NOT_FOUND')
  }

  return target
}

function mapPaymentOrderRow(row: PaymentOrderRow): BillingOrder {
  return {
    id: row.id,
    orderNo: row.out_trade_no,
    packageId: row.package_id,
    packageName: row.title,
    amountFen: row.amount_fen,
    points: row.points,
    channel: row.channel,
    status: row.status,
    qrCodeContent: row.qr_code_content ?? '',
    paymentUrl: row.payment_url ?? undefined,
    providerOrderId: row.provider_order_id ?? undefined,
    providerMessage: row.provider_message ?? undefined,
    pointLogId: row.point_log_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at ?? undefined,
  }
}

function mapPointLedgerRow(row: PointLedgerRow, balanceAfter: number): PointLedgerEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    description: row.note,
    delta: row.change_points,
    balanceAfter,
    entryType: row.entry_type,
    actionType: row.action_type ?? undefined,
    operationKey: row.operation_key ?? undefined,
  }
}

function createOrderNo() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = Math.floor(Math.random() * 900 + 100)
  return `LV${stamp}${suffix}`
}

function summarizeOrders(orders: BillingOrder[]) {
  return {
    total: orders.length,
    paid: orders.filter((item) => item.status === 'paid').length,
    pending: orders.filter((item) => item.status === 'pending').length,
    totalAmountFen: orders.filter((item) => item.status === 'paid').reduce((sum, item) => sum + item.amountFen, 0),
    totalPoints: orders.filter((item) => item.status === 'paid').reduce((sum, item) => sum + item.points, 0),
  }
}

async function resolveBillingIdentity(actor?: AuthenticatedActor | null): Promise<BillingIdentity> {
  if (!actor) {
    return {
      workspaceUserId: DEFAULT_WORKSPACE_USER_ID,
      commercialUserId: null,
      organizationId: null,
      email: accountSummary.email,
      name: accountSummary.displayName,
    }
  }

  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const user = store.users.find((item) => item.id === actor.userId && item.status === 'active')
    if (!user) {
      throw new AppError('当前账户不存在。', 404, 'USER_NOT_FOUND')
    }

    return {
      workspaceUserId: actor.userId,
      commercialUserId: actor.userId,
      organizationId: actor.organizationId,
      email: user.email,
      name: user.name,
    }
  }

  const result = await query<{ name: string; email: string }>(
    'SELECT name, email FROM users WHERE id = $1 LIMIT 1',
    [actor.userId],
  )

  if (!result.rowCount) {
    throw new AppError('当前账户不存在。', 404, 'USER_NOT_FOUND')
  }

  return {
    workspaceUserId: actor.userId,
    commercialUserId: actor.userId,
    organizationId: actor.organizationId,
    email: result.rows[0].email,
    name: result.rows[0].name,
  }
}

async function listStoredOrders(identity: BillingIdentity, limit = 50) {
  const result = await query<PaymentOrderRow>(
    `
      SELECT
        id,
        package_id,
        channel,
        title,
        description,
        amount_fen,
        points,
        out_trade_no,
        status,
        qr_code_content,
        payment_url,
        provider_order_id,
        provider_message,
        point_log_id,
        created_at,
        updated_at,
        expires_at,
        paid_at
      FROM payment_orders
      WHERE workspace_user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [identity.workspaceUserId, limit],
  )

  return result.rows.map(mapPaymentOrderRow)
}

async function listDevStoredOrders(identity: BillingIdentity, limit = 50) {
  const store = await readDevStore()
  return store.paymentOrders
    .filter((item) => item.userId === identity.workspaceUserId && item.organizationId === identity.organizationId)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit)
}

async function findStoredOrder(identity: BillingIdentity, orderId: string) {
  const result = await query<PaymentOrderRow>(
    `
      SELECT
        id,
        package_id,
        channel,
        title,
        description,
        amount_fen,
        points,
        out_trade_no,
        status,
        qr_code_content,
        payment_url,
        provider_order_id,
        provider_message,
        point_log_id,
        created_at,
        updated_at,
        expires_at,
        paid_at
      FROM payment_orders
      WHERE workspace_user_id = $1
        AND (id::text = $2 OR out_trade_no = $2)
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [identity.workspaceUserId, orderId],
  )

  return result.rows[0] ? mapPaymentOrderRow(result.rows[0]) : null
}

async function findDevStoredOrder(identity: BillingIdentity, orderId: string) {
  const store = await readDevStore()
  return store.paymentOrders.find((item) => (
    item.userId === identity.workspaceUserId
    && item.organizationId === identity.organizationId
    && (item.id === orderId || item.orderNo === orderId)
  )) ?? null
}

async function findStoredOrderByTradeNo(outTradeNo: string) {
  const result = await query<PaymentOrderRow>(
    `
      SELECT
        organization_id,
        commercial_user_id,
        workspace_user_id,
        workspace_user_email,
        workspace_user_name,
        id,
        package_id,
        channel,
        title,
        description,
        amount_fen,
        points,
        out_trade_no,
        status,
        qr_code_content,
        payment_url,
        provider_order_id,
        provider_message,
        point_log_id,
        created_at,
        updated_at,
        expires_at,
        paid_at
      FROM payment_orders
      WHERE out_trade_no = $1
      LIMIT 1
    `,
    [outTradeNo],
  )

  const row = result.rows[0]
  if (!row) {
    return null
  }

  return {
    identity: {
      workspaceUserId: row.workspace_user_id ?? DEFAULT_WORKSPACE_USER_ID,
      commercialUserId: row.commercial_user_id ?? null,
      organizationId: row.organization_id ?? null,
      email: row.workspace_user_email ?? accountSummary.email,
      name: row.workspace_user_name ?? accountSummary.displayName,
    },
    order: mapPaymentOrderRow(row),
  }
}

async function upsertStoredOrder(identity: BillingIdentity, order: BillingOrder, rechargePackage: BillingPackage, client?: PoolClient) {
  const result = await (client ?? getPool()).query<PaymentOrderRow>(
    `
      INSERT INTO payment_orders (
        id,
        organization_id,
        commercial_user_id,
        workspace_user_id,
        workspace_user_email,
        workspace_user_name,
        package_id,
        channel,
        title,
        description,
        amount_fen,
        points,
        out_trade_no,
        status,
        qr_code_content,
        payment_url,
        provider_order_id,
        provider_message,
        point_log_id,
        provider_payload,
        updated_at,
        expires_at,
        paid_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22, $23
      )
      ON CONFLICT (id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        commercial_user_id = EXCLUDED.commercial_user_id,
        workspace_user_email = EXCLUDED.workspace_user_email,
        workspace_user_name = EXCLUDED.workspace_user_name,
        package_id = EXCLUDED.package_id,
        channel = EXCLUDED.channel,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        amount_fen = EXCLUDED.amount_fen,
        points = EXCLUDED.points,
        out_trade_no = EXCLUDED.out_trade_no,
        status = CASE WHEN payment_orders.status = 'paid' THEN 'paid' ELSE EXCLUDED.status END,
        qr_code_content = EXCLUDED.qr_code_content,
        payment_url = EXCLUDED.payment_url,
        provider_order_id = EXCLUDED.provider_order_id,
        provider_message = EXCLUDED.provider_message,
        point_log_id = COALESCE(payment_orders.point_log_id, EXCLUDED.point_log_id),
        provider_payload = EXCLUDED.provider_payload,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at,
        paid_at = COALESCE(payment_orders.paid_at, EXCLUDED.paid_at)
      RETURNING
        id,
        package_id,
        channel,
        title,
        description,
        amount_fen,
        points,
        out_trade_no,
        status,
        qr_code_content,
        payment_url,
        provider_order_id,
        provider_message,
        point_log_id,
        created_at,
        updated_at,
        expires_at,
        paid_at
    `,
    [
      order.id,
      identity.organizationId,
      identity.commercialUserId,
      identity.workspaceUserId,
      identity.email,
      identity.name,
      order.packageId,
      order.channel,
      rechargePackage.name,
      rechargePackage.description,
      order.amountFen,
      order.points,
      order.orderNo,
      order.status,
      order.qrCodeContent || null,
      order.paymentUrl ?? null,
      order.providerOrderId ?? null,
      order.providerMessage ?? null,
      order.pointLogId ?? null,
      JSON.stringify({
        packageName: rechargePackage.name,
        packageDescription: rechargePackage.description,
      }),
      order.updatedAt ?? order.createdAt,
      order.expiresAt ?? new Date(Date.now() + 1000 * 60 * 30).toISOString(),
      order.paidAt ?? null,
    ],
  )

  return mapPaymentOrderRow(result.rows[0])
}

async function upsertDevStoredOrder(identity: BillingIdentity, order: BillingOrder) {
  return updateDevStore((store) => {
    const existingIndex = store.paymentOrders.findIndex((item) => item.id === order.id)
    const nextOrder = {
      ...order,
      organizationId: identity.organizationId ?? '',
      userId: identity.workspaceUserId,
    }

    if (existingIndex >= 0) {
      store.paymentOrders.splice(existingIndex, 1, nextOrder)
    } else {
      store.paymentOrders.unshift(nextOrder)
    }

    return nextOrder
  })
}

async function ensureStoredPointLedger(identity: BillingIdentity, order: BillingOrder, client: PoolClient) {
  if (!identity.organizationId || !identity.commercialUserId) {
    return null
  }

  await client.query(
    `INSERT INTO point_accounts (organization_id, user_id, balance_points)
     VALUES ($1, $2, 0) ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [identity.organizationId, identity.commercialUserId],
  )
  const result = await client.query<{ id: string }>(
    `
      WITH inserted AS (
        INSERT INTO point_ledger_entries (
          organization_id,
          commercial_user_id,
          workspace_user_id,
          workspace_user_email,
          workspace_user_name,
          order_id,
          entry_type,
          change_points,
          note,
          metadata,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'recharge', $7, $8, $9::jsonb, $10)
        ON CONFLICT (order_id, entry_type) DO NOTHING
        RETURNING id, change_points
      ),
      bumped AS (
        UPDATE point_accounts
        SET
          balance_points = point_accounts.balance_points + inserted.change_points,
          updated_at = NOW()
        FROM inserted
        WHERE point_accounts.organization_id = $1
          AND point_accounts.user_id = $2
        RETURNING inserted.id
      )
      SELECT COALESCE((SELECT id FROM bumped LIMIT 1), (SELECT id FROM inserted LIMIT 1)) AS id
    `,
    [
      identity.organizationId,
      identity.commercialUserId,
      identity.workspaceUserId,
      identity.email,
      identity.name,
      order.id,
      order.points,
      `${order.channel === 'alipay' ? '支付宝' : '微信支付'}充值 ${order.points} 积分`,
      JSON.stringify({
        orderNo: order.orderNo,
        channel: order.channel,
        amountFen: order.amountFen,
        packageId: order.packageId,
      }),
      order.paidAt ?? new Date().toISOString(),
    ],
  )

  if (result.rows[0]?.id) return result.rows[0].id
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM point_ledger_entries WHERE order_id = $1 AND entry_type = 'recharge'`,
    [order.id],
  )
  return existing.rows[0]?.id ?? null
}

async function settleStoredPaidOrder(identity: BillingIdentity, order: BillingOrder) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // Serialize callbacks, polling and simulated payment for the same order.
    const locked = await client.query<PaymentOrderRow>(
      'SELECT * FROM payment_orders WHERE id = $1 AND workspace_user_id = $2 FOR UPDATE',
      [order.id, identity.workspaceUserId],
    )
    if (!locked.rows[0]) throw new AppError('订单不存在。', 404, 'ORDER_NOT_FOUND')
    const stored = mapPaymentOrderRow(locked.rows[0])
    const pointLogId = await ensureStoredPointLedger(identity, order, client)
    if (!pointLogId) throw new AppError('积分到账失败，请稍后重试。', 500, 'BILLING_POINTS_FAILED')
    const paid = await upsertStoredOrder(identity, {
      ...order, status: 'paid', pointLogId,
      paidAt: stored.paidAt ?? order.paidAt ?? new Date().toISOString(),
    }, getRechargePackage(order.packageId), client)
    if (identity.commercialUserId) await rewardStoredReferral(client, identity.commercialUserId, paid)
    await client.query('COMMIT')
    return paid
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function ensureDevPointLedger(identity: BillingIdentity, order: BillingOrder) {
  if (!identity.organizationId || !identity.commercialUserId) {
    return null
  }

  const organizationId = identity.organizationId
  const commercialUserId = identity.commercialUserId

  return updateDevStore((store) => {
    const existing = store.pointLedgerEntries.find((item) => item.orderId === order.id && item.entryType === 'recharge')
    if (existing) {
      rewardDevReferral(store, commercialUserId, order)
      return existing.id
    }

    const pointLogId = `point-${randomUUID()}`
    store.pointLedgerEntries.unshift({
      id: pointLogId,
      organizationId,
      userId: commercialUserId,
      orderId: order.id,
      entryType: 'recharge',
      operationKey: undefined,
      actionType: undefined,
      relatedEntryId: undefined,
      changePoints: order.points,
      note: `${order.channel === 'alipay' ? '支付宝' : '微信支付'}充值 ${order.points} 积分`,
      metadata: {
        orderNo: order.orderNo,
        channel: order.channel,
        amountFen: order.amountFen,
        packageId: order.packageId,
      },
      createdAt: order.paidAt ?? new Date().toISOString(),
    })

    const pointAccount = store.pointAccounts.find((item) => item.organizationId === organizationId && item.userId === commercialUserId)
    if (pointAccount) {
      pointAccount.balancePoints += order.points
    } else {
      store.pointAccounts.push({
        organizationId,
        userId: commercialUserId,
        balancePoints: order.points,
      })
    }

    rewardDevReferral(store, commercialUserId, order)
    return pointLogId
  })
}

async function storePaymentCallback(input: PaymentCallbackInput) {
  if (!isDatabaseEnabled()) {
    return
  }

  await query(
    `
      INSERT INTO payment_callbacks (
        provider,
        out_trade_no,
        provider_order_id,
        payload
      ) VALUES ($1, $2, $3, $4::jsonb)
    `,
    [
      input.provider,
      input.outTradeNo ?? null,
      input.providerOrderId ?? null,
      JSON.stringify(input.payload),
    ],
  )
}

async function markRechargeOrderPaidByTradeNo(input: PaymentCallbackInput) {
  if (!isDatabaseEnabled() || !input.outTradeNo) {
    return null
  }

  const stored = await findStoredOrderByTradeNo(input.outTradeNo)
  if (!stored) {
    return null
  }

  const rechargePackage = getRechargePackage(stored.order.packageId)
  let order: BillingOrder = {
    ...stored.order,
    status: input.status,
    providerOrderId: input.providerOrderId ?? stored.order.providerOrderId,
    providerMessage: input.providerMessage ?? stored.order.providerMessage,
    paidAt: input.paidAt ?? stored.order.paidAt,
    updatedAt: new Date().toISOString(),
  }

  if (order.status === 'paid') {
    return settleStoredPaidOrder(stored.identity, order)
  }

  return upsertStoredOrder(stored.identity, order, rechargePackage)
}

async function getStoredAccountSummary(actor: AuthenticatedActor) {
  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const user = store.users.find((item) => item.id === actor.userId && item.status === 'active')
    const organization = store.organizations.find((item) => item.id === actor.organizationId && item.status === 'active')
    const membership = store.memberships.find((item) => item.id === actor.membershipId && item.organizationId === actor.organizationId && item.userId === actor.userId && item.status === 'active')
    if (!user || !organization || !membership) {
      throw new AppError('当前账户不存在。', 404, 'ACCOUNT_NOT_FOUND')
    }

    const pointAccount = store.pointAccounts.find((item) => item.organizationId === actor.organizationId && item.userId === actor.userId)
    const latestPaidOrder = store.paymentOrders
      .filter((item) => item.organizationId === actor.organizationId && item.userId === actor.userId && item.status === 'paid')
      .sort((left, right) => new Date(right.paidAt || right.createdAt).getTime() - new Date(left.paidAt || left.createdAt).getTime())[0]

    let subscriptionExpiresAt = ''
    if (latestPaidOrder?.paidAt && ['personal-monthly', 'pro-monthly'].includes(latestPaidOrder.packageId)) {
      subscriptionExpiresAt = new Date(new Date(latestPaidOrder.paidAt).getTime() + 1000 * 60 * 60 * 24 * 30).toISOString()
    }

    return {
      id: user.id,
      displayName: user.name,
      email: user.email,
      tierName: latestPaidOrder?.packageName ?? '未开通套餐',
      pointsBalance: pointAccount?.balancePoints ?? 0,
      subscriptionExpiresAt,
    }
  }

  const result = await query<BillingAccountSummaryRow>(
    `
      SELECT
        u.id AS user_id,
        u.name AS display_name,
        u.email,
        pa.balance_points,
        latest_plan.title AS tier_name,
        latest_plan.subscription_expires_at
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.id = $2 AND m.organization_id = $1 AND m.status = 'active'
      LEFT JOIN point_accounts pa ON pa.organization_id = m.organization_id AND pa.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT
          po.title,
          CASE
            WHEN po.package_id IN ('personal-monthly', 'pro-monthly') THEN (po.paid_at + INTERVAL '30 days')::text
            WHEN po.package_id = 'team-custom' THEN (po.paid_at + INTERVAL '365 days')::text
            ELSE NULL
          END AS subscription_expires_at
        FROM payment_orders po
        WHERE po.organization_id = m.organization_id
          AND po.commercial_user_id = u.id
          AND po.status = 'paid'
        ORDER BY COALESCE(po.paid_at, po.created_at) DESC
        LIMIT 1
      ) AS latest_plan ON TRUE
      WHERE u.id = $3
      LIMIT 1
    `,
    [actor.organizationId, actor.membershipId, actor.userId],
  )

  if (!result.rowCount) {
    throw new AppError('当前账户不存在。', 404, 'ACCOUNT_NOT_FOUND')
  }

  const row = result.rows[0]
  return {
    id: row.user_id,
    displayName: row.display_name,
    email: row.email,
    tierName: row.tier_name ?? '未开通套餐',
    pointsBalance: row.balance_points ?? 0,
    subscriptionExpiresAt: row.subscription_expires_at ?? '',
  }
}

function markInMemoryOrderPaid(order: BillingOrder, paidAt: string) {
  const existing = inMemoryOrders.find((item) => item.id === order.id)
  if (!existing || existing.status === 'paid') {
    return existing ?? order
  }

  const pointLogId = existing.pointLogId ?? `point-${randomUUID()}`
  const nextOrder: BillingOrder = {
    ...existing,
    status: 'paid',
    pointLogId,
    paidAt,
    updatedAt: new Date().toISOString(),
  }

  const index = inMemoryOrders.findIndex((item) => item.id === order.id)
  inMemoryOrders.splice(index, 1, nextOrder)

  if (!existing.pointLogId) {
    inMemoryPointLedger.unshift({
      id: pointLogId,
      createdAt: paidAt,
      description: `${order.channel === 'alipay' ? '支付宝' : '微信支付'}充值 ${order.points} 积分`,
      delta: order.points,
      balanceAfter: accountSummary.pointsBalance + inMemoryPointLedger.reduce((sum, item) => sum + item.delta, 0) + order.points,
    })
  }

  return nextOrder
}

export async function getBillingCatalog() {
  return {
    providers: getPaymentProviderStatuses(),
    packages: billingPackages,
  }
}

export async function listRechargePaymentOrders(actor?: AuthenticatedActor, limit = 50) {
  const identity = await resolveBillingIdentity(actor)
  const orders = actor
    ? isDatabaseEnabled()
      ? await listStoredOrders(identity, limit)
      : await listDevStoredOrders(identity, limit)
    : inMemoryOrders.slice(0, limit)

  return {
    items: orders,
    summary: summarizeOrders(orders),
  }
}

export async function createRechargePaymentOrder(
  actor: AuthenticatedActor | undefined,
  payload: {
    channel: BillingOrder['channel']
    packageId: string
  },
) {
  const provider = getPaymentProviderStatuses().find((item) => item.id === payload.channel)
  if (!provider?.enabled) {
    throw new AppError(provider?.reason || '当前支付通道未启用。', 400, 'PAYMENT_PROVIDER_DISABLED')
  }

  const rechargePackage = getRechargePackage(payload.packageId)
  const outTradeNo = createOrderNo()
  const gatewayOrder = await createGatewayRechargeOrder(payload.channel, {
    outTradeNo,
    title: rechargePackage.name,
    description: rechargePackage.description,
    amountFen: rechargePackage.amountFen,
  })
  const identity = await resolveBillingIdentity(actor)
  const now = new Date().toISOString()

  let order: BillingOrder = {
    id: randomUUID(),
    orderNo: outTradeNo,
    packageId: rechargePackage.id,
    packageName: rechargePackage.name,
    amountFen: rechargePackage.amountFen,
    points: rechargePackage.points,
    channel: payload.channel,
    status: 'pending',
    qrCodeContent: gatewayOrder.qrCodeContent,
    paymentUrl: gatewayOrder.paymentUrl,
    providerOrderId: gatewayOrder.providerOrderId,
    providerMessage: gatewayOrder.providerMessage,
    createdAt: now,
    updatedAt: now,
    expiresAt: gatewayOrder.expiresAt ?? new Date(Date.now() + 1000 * 60 * 30).toISOString(),
  }

  if (actor) {
    order = isDatabaseEnabled()
      ? await upsertStoredOrder(identity, order, rechargePackage)
      : await upsertDevStoredOrder(identity, order)
  } else {
    inMemoryOrders.unshift(order)
  }

  return {
    order,
    providers: getPaymentProviderStatuses(),
    packages: billingPackages,
  }
}

export async function getRechargePaymentOrder(actor: AuthenticatedActor | undefined, orderId: string) {
  const identity = await resolveBillingIdentity(actor)

  let order = actor
    ? isDatabaseEnabled()
      ? await findStoredOrder(identity, orderId)
      : await findDevStoredOrder(identity, orderId)
    : inMemoryOrders.find((item) => item.id === orderId || item.orderNo === orderId) ?? null

  if (!order) {
    throw new AppError('订单不存在。', 404, 'ORDER_NOT_FOUND')
  }

  const rechargePackage = getRechargePackage(order.packageId)

  if (order.status === 'pending') {
    const providerState = await queryGatewayRechargeOrder(order.channel, order.orderNo)
    order = {
      ...order,
      status: providerState.status,
      providerOrderId: providerState.providerOrderId ?? order.providerOrderId,
      providerMessage: providerState.providerMessage ?? order.providerMessage,
      paidAt: providerState.paidAt ?? order.paidAt,
      updatedAt: new Date().toISOString(),
    }

    if (order.status === 'paid' && !order.pointLogId) {
      if (actor) {
        const pointLogId = isDatabaseEnabled()
          ? (await settleStoredPaidOrder(identity, order)).pointLogId
          : await ensureDevPointLedger(identity, order)
        order = {
          ...order,
          pointLogId: pointLogId ?? undefined,
        }
      } else {
        order = markInMemoryOrderPaid(order, order.paidAt ?? new Date().toISOString())
      }
    }

    if (actor) {
      order = isDatabaseEnabled()
        ? await upsertStoredOrder(identity, order, rechargePackage)
        : await upsertDevStoredOrder(identity, order)
    } else {
      const ensuredOrder = order
      const index = inMemoryOrders.findIndex((item) => item.id === ensuredOrder.id)
      if (index >= 0) {
        inMemoryOrders.splice(index, 1, ensuredOrder)
      }
    }
  }

  return {
    order,
  }
}

export async function listRechargePointLedger(actor?: AuthenticatedActor, limit = 100) {
  if (!actor) {
    return {
      items: inMemoryPointLedger.slice(0, limit),
    }
  }

  const identity = await resolveBillingIdentity(actor)
  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const rows = store.pointLedgerEntries
      .filter((item) => item.organizationId === actor.organizationId && item.userId === actor.userId)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .slice(0, limit)

    const summary = await getStoredAccountSummary(actor)
    let balance = summary.pointsBalance
    return {
      items: rows.map((row) => {
        const entry = mapPointLedgerRow({
          id: row.id,
          entry_type: row.entryType,
          action_type: row.actionType,
          operation_key: row.operationKey,
          change_points: row.changePoints,
          note: row.note,
          created_at: row.createdAt,
        }, balance)
        balance -= row.changePoints
        return entry
      }),
    }
  }

  const result = await query<PointLedgerRow>(
    `
      SELECT id, entry_type, action_type, operation_key, change_points, note, created_at
      FROM point_ledger_entries
      WHERE workspace_user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [identity.workspaceUserId, limit],
  )

  const summary = await getStoredAccountSummary(actor)
  let balance = summary.pointsBalance
  const items = result.rows.map((row) => {
    const entry = mapPointLedgerRow(row, balance)
    balance -= row.change_points
    return entry
  })

  return {
    items,
  }
}

export async function getBillingAccountSummary(actor?: AuthenticatedActor) {
  if (actor) {
    return getStoredAccountSummary(actor)
  }

  const ledger = await listRechargePointLedger(undefined, 100)
  const delta = ledger.items.reduce((sum, item) => sum + item.delta, 0)

  return {
    ...accountSummary,
    pointsBalance: accountSummary.pointsBalance + delta,
  }
}

export async function getDesktopDevelopmentSyncByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    throw new AppError('缺少桌面端账户邮箱。', 400, 'DESKTOP_EMAIL_REQUIRED')
  }

  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const user = store.users.find((item) => item.email === normalizedEmail && item.status === 'active')
    if (!user) {
      throw new AppError('云端未找到对应账户。', 404, 'DESKTOP_ACCOUNT_NOT_FOUND')
    }

    const membership = store.memberships.find((item) => item.userId === user.id && item.status === 'active')
    if (!membership) {
      throw new AppError('云端未找到对应组织。', 404, 'DESKTOP_MEMBERSHIP_NOT_FOUND')
    }

    const actor: AuthenticatedActor = {
      userId: user.id,
      organizationId: membership.organizationId,
      membershipId: membership.id,
      role: membership.role,
      email: user.email,
      sessionId: user.currentSessionId ?? 'desktop-sync',
    }

    const [account, ledger] = await Promise.all([
      getStoredAccountSummary(actor),
      listRechargePointLedger(actor, 100),
    ])

    return {
      account,
      ledger,
    }
  }

  const result = await query<{
    user_id: string
    organization_id: string
    membership_id: string
    role: AuthenticatedActor['role']
    email: string
  }>(
    `
      SELECT
        u.id AS user_id,
        o.id AS organization_id,
        m.id AS membership_id,
        m.role,
        u.email
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.status = 'active'
      JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
      WHERE u.email = $1 AND u.status = 'active'
      ORDER BY m.created_at ASC
      LIMIT 1
    `,
    [normalizedEmail],
  )

  if (!result.rowCount) {
    throw new AppError('云端未找到对应账户。', 404, 'DESKTOP_ACCOUNT_NOT_FOUND')
  }

  const actor: AuthenticatedActor = {
    userId: result.rows[0].user_id,
    organizationId: result.rows[0].organization_id,
    membershipId: result.rows[0].membership_id,
    role: result.rows[0].role,
    email: result.rows[0].email,
    sessionId: 'desktop-sync',
  }

  const [account, ledger] = await Promise.all([
    getStoredAccountSummary(actor),
    listRechargePointLedger(actor, 100),
  ])

  return {
    account,
    ledger,
  }
}

export async function getUsageSummary(actor?: AuthenticatedActor): Promise<{ items: UsageMetric[] }> {
  const summary = await getBillingAccountSummary(actor)
  let docGenCount = 0
  let evidenceCount = 0
  let knowledgeCount = 0

  if (actor && isDatabaseEnabled()) {
    const result = await query<{ action_type: string, count: string }>(
      `
        SELECT action_type, COUNT(*) as count
        FROM point_ledger_entries
        WHERE organization_id = $1
          AND commercial_user_id = $2
          AND entry_type = 'consume'
          AND created_at >= date_trunc('month', current_date)
        GROUP BY action_type
      `,
      [actor.organizationId, actor.userId]
    )

    for (const row of result.rows) {
      const count = parseInt(row.count, 10)
      if (['crosscheck_paragraph', 'crosscheck_full', 'pleading_full'].includes(row.action_type)) {
        docGenCount += count
      } else if (['evidence_summary', 'evidence_match', 'document_parse'].includes(row.action_type)) {
        evidenceCount += count
      } else if (['legal_check', 'case_reference'].includes(row.action_type)) {
        knowledgeCount += count
      }
    }
  } else if (actor && !isDatabaseEnabled()) {
    const store = await readDevStore()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const entries = store.pointLedgerEntries.filter(
      (item) => item.organizationId === actor.organizationId &&
                item.userId === actor.userId &&
                item.entryType === 'consume' &&
                item.createdAt >= startOfMonth
    )
    for (const entry of entries) {
      if (['crosscheck_paragraph', 'crosscheck_full', 'pleading_full'].includes(entry.actionType!)) {
        docGenCount += 1
      } else if (['evidence_summary', 'evidence_match', 'document_parse'].includes(entry.actionType!)) {
        evidenceCount += 1
      } else if (['legal_check', 'case_reference'].includes(entry.actionType!)) {
        knowledgeCount += 1
      }
    }
  } else if (!actor) {
    docGenCount = 82
    evidenceCount = 436
    knowledgeCount = 291
  }

  return {
    items: [
      { label: '本月文书生成', value: `${docGenCount} 次` },
      { label: '证据理解', value: `${evidenceCount} 次` },
      { label: '知识库检索', value: `${knowledgeCount} 次` },
      { label: '剩余积分', value: summary.pointsBalance.toLocaleString() },
    ]
  }
}

export async function handlePaymentCallback(input: PaymentCallbackInput) {
  await storePaymentCallback(input)
  return markRechargeOrderPaidByTradeNo(input)
}

export async function completeRechargePaymentOrderForDevelopment(
  actor: AuthenticatedActor | undefined,
  orderId: string,
) {
  const result = await getRechargePaymentOrder(actor, orderId)
  const order = result.order
  const paidAt = new Date().toISOString()
  const rechargePackage = getRechargePackage(order.packageId)

  if (order.status === 'paid' && order.pointLogId) {
    return result
  }

  if (actor) {
    const identity = await resolveBillingIdentity(actor)
    let nextOrder: BillingOrder = {
      ...order,
      status: 'paid',
      providerOrderId: order.providerOrderId ?? `dev-${order.channel}-${order.orderNo}`,
      providerMessage: 'DEVELOPMENT_SIMULATED_PAID',
      paidAt,
      updatedAt: paidAt,
    }
    if (!order.providerOrderId?.startsWith(`dev-${order.channel}-`)) {
      throw new AppError('该订单不是模拟支付订单。', 400, 'BILLING_NOT_SIMULATED')
    }
    if (isDatabaseEnabled()) {
      return { order: await settleStoredPaidOrder(identity, nextOrder) }
    }
    const pointLogId = await ensureDevPointLedger(identity, nextOrder)

    if (!pointLogId && identity.organizationId && identity.commercialUserId) {
      throw new AppError('模拟支付已完成，但积分账本写入失败。', 500, 'BILLING_DEV_COMPLETE_POINTS_FAILED')
    }

    nextOrder = {
      ...nextOrder,
      pointLogId: pointLogId ?? undefined,
    }

    const storedOrder = isDatabaseEnabled()
      ? await upsertStoredOrder(identity, nextOrder, rechargePackage)
      : await upsertDevStoredOrder(identity, nextOrder)

    return {
      order: storedOrder,
    }
  }

  await handlePaymentCallback({
    provider: order.channel,
    outTradeNo: order.orderNo,
    providerOrderId: order.providerOrderId ?? `dev-${order.channel}-${order.orderNo}`,
    status: 'paid',
    paidAt,
    providerMessage: 'DEVELOPMENT_SIMULATED_PAID',
    payload: {
      mode: 'development-simulation',
      orderId: order.id,
      orderNo: order.orderNo,
    },
  })

  return getRechargePaymentOrder(actor, order.id)
}
