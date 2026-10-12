import { AppError } from './core/app-error.js'
import type {
  PaymentProvider,
  PointLog,
  RechargeOrder,
  RechargePackage,
  WorkspaceState,
} from './domain.js'
import { isDatabaseEnabled, query } from './infrastructure/postgres.js'
import {
  createGatewayRechargeOrder,
  getPaymentProviderStatuses,
  queryGatewayRechargeOrder,
} from './integrations/payment.js'
import { readWorkspace, writeWorkspace } from './store.js'
import { recordAuditEvent } from './commercial/audit-service.js'

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

type BillingIdentity = {
  organizationId: string | null
  commercialUserId: string | null
}

type PaymentOrderRow = {
  id: string
  workspace_user_id: string
  package_id: string
  channel: PaymentProvider
  title: string
  description: string
  amount_fen: number
  points: number
  out_trade_no: string
  status: RechargeOrder['status']
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
  change_points: number
  note: string
  created_at: string
}

const RECHARGE_PACKAGES: RechargePackage[] = [
  {
    id: 'pkg-100',
    title: '基础包',
    description: '100 积分，适合轻量生成与核验。',
    points: 100,
    amountFen: 1000,
  },
  {
    id: 'pkg-500',
    title: '进阶包',
    description: '500 积分，适合连续处理多个案件。',
    points: 500,
    amountFen: 4500,
  },
  {
    id: 'pkg-1200',
    title: '专业包',
    description: '1200 积分，适合高频专业使用。',
    points: 1200,
    amountFen: 9800,
  },
]

function getRechargePackage(packageId: string) {
  const target = RECHARGE_PACKAGES.find((item) => item.id === packageId)
  if (!target) {
    throw new AppError('充值套餐不存在。', 404, 'RECHARGE_PACKAGE_NOT_FOUND')
  }

  return target
}

function mapPaymentOrderRow(row: PaymentOrderRow): RechargeOrder {
  return {
    id: row.id,
    userId: row.workspace_user_id,
    packageId: row.package_id,
    channel: row.channel,
    title: row.title,
    description: row.description,
    amountFen: row.amount_fen,
    points: row.points,
    outTradeNo: row.out_trade_no,
    status: row.status,
    qrCodeContent: row.qr_code_content ?? undefined,
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

function mapPointLedgerRow(row: PointLedgerRow): PointLog {
  return {
    id: row.id,
    type: 'recharge',
    amount: row.change_points,
    note: row.note,
    createdAt: row.created_at,
  }
}

async function resolveBillingIdentity(workspace: WorkspaceState): Promise<BillingIdentity> {
  if (!isDatabaseEnabled() || !workspace.user.email?.trim()) {
    return {
      organizationId: null,
      commercialUserId: null,
    }
  }

  const result = await query<{
    user_id: string
    organization_id: string | null
  }>(
    `
      SELECT u.id AS user_id, om.organization_id
      FROM users u
      LEFT JOIN organization_memberships om
        ON om.user_id = u.id
       AND om.status = 'active'
      WHERE lower(u.email) = lower($1)
      ORDER BY om.created_at ASC NULLS LAST
      LIMIT 1
    `,
    [workspace.user.email.trim()],
  )

  if (!result.rowCount) {
    return {
      organizationId: null,
      commercialUserId: null,
    }
  }

  return {
    organizationId: result.rows[0].organization_id ?? null,
    commercialUserId: result.rows[0].user_id,
  }
}

async function listStoredRechargeOrdersForUser(userId: string, limit = 50) {
  const result = await query<PaymentOrderRow>(
    `
      SELECT
        id,
        workspace_user_id,
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
    [userId, limit],
  )

  return result.rows.map(mapPaymentOrderRow)
}

async function listStoredRechargePointLogsForUser(userId: string, limit = 100) {
  const result = await query<PointLedgerRow>(
    `
      SELECT id, change_points, note, created_at
      FROM point_ledger_entries
      WHERE workspace_user_id = $1
        AND entry_type = 'recharge'
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [userId, limit],
  )

  return result.rows.map(mapPointLedgerRow)
}

async function upsertStoredRechargeOrder(workspace: WorkspaceState, order: RechargeOrder) {
  if (!isDatabaseEnabled()) {
    return order
  }

  const identity = await resolveBillingIdentity(workspace)
  const result = await query<PaymentOrderRow>(
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
        updated_at,
        expires_at,
        paid_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
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
        status = EXCLUDED.status,
        qr_code_content = EXCLUDED.qr_code_content,
        payment_url = EXCLUDED.payment_url,
        provider_order_id = EXCLUDED.provider_order_id,
        provider_message = EXCLUDED.provider_message,
        point_log_id = EXCLUDED.point_log_id,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at,
        paid_at = EXCLUDED.paid_at
      RETURNING
        id,
        workspace_user_id,
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
      workspace.user.id,
      workspace.user.email || null,
      workspace.user.name || null,
      order.packageId,
      order.channel,
      order.title,
      order.description,
      order.amountFen,
      order.points,
      order.outTradeNo,
      order.status,
      order.qrCodeContent ?? null,
      order.paymentUrl ?? null,
      order.providerOrderId ?? null,
      order.providerMessage ?? null,
      order.pointLogId ?? null,
      order.updatedAt,
      order.expiresAt,
      order.paidAt ?? null,
    ],
  )

  return mapPaymentOrderRow(result.rows[0])
}

async function createStoredRechargePointLog(workspace: WorkspaceState, order: RechargeOrder, paidAt: string) {
  if (!isDatabaseEnabled()) {
    return null
  }

  const identity = await resolveBillingIdentity(workspace)
  const result = await query<PointLedgerRow>(
    `
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
      ON CONFLICT (order_id, entry_type) DO UPDATE SET
        note = EXCLUDED.note
      RETURNING id, change_points, note, created_at
    `,
    [
      identity.organizationId,
      identity.commercialUserId,
      workspace.user.id,
      workspace.user.email || null,
      workspace.user.name || null,
      order.id,
      order.points,
      `${order.channel === 'alipay' ? '支付宝' : '微信支付'}充值 ${order.points} 积分`,
      JSON.stringify({
        outTradeNo: order.outTradeNo,
        channel: order.channel,
        amountFen: order.amountFen,
        packageId: order.packageId,
      }),
      paidAt,
    ],
  )

  return mapPointLedgerRow(result.rows[0])
}

function findRechargeOrder(workspace: WorkspaceState, orderId: string) {
  const order = workspace.paymentOrders.find((item) => item.id === orderId)
  if (!order) {
    throw new AppError('充值订单不存在。', 404, 'RECHARGE_ORDER_NOT_FOUND')
  }

  return order
}

function replaceRechargeOrder(workspace: WorkspaceState, nextOrder: RechargeOrder) {
  workspace.paymentOrders = workspace.paymentOrders
    .map((item) => (item.id === nextOrder.id ? nextOrder : item))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
}

function appendRechargeOrder(workspace: WorkspaceState, order: RechargeOrder) {
  workspace.paymentOrders = [order, ...(workspace.paymentOrders ?? [])]
}

function markPaidAndCreditPoints(workspace: WorkspaceState, order: RechargeOrder, paidAt?: string) {
  if (order.status === 'paid' && order.pointLogId) {
    return order
  }

  const pointLogId = order.pointLogId ?? createId('point')
  const paidTime = paidAt ?? new Date().toISOString()

  if (!order.pointLogId) {
    workspace.user.points += order.points
    workspace.user.pointLogs.unshift({
      id: pointLogId,
      type: 'recharge',
      amount: order.points,
      note: `${order.channel === 'alipay' ? '支付宝' : '微信支付'}充值 ${order.points} 积分`,
      createdAt: paidTime,
    })
  }

  const nextOrder: RechargeOrder = {
    ...order,
    status: 'paid',
    pointLogId,
    paidAt: paidTime,
    updatedAt: new Date().toISOString(),
  }

  replaceRechargeOrder(workspace, nextOrder)
  return nextOrder
}

function closeExpiredOrder(workspace: WorkspaceState, order: RechargeOrder) {
  if (order.status !== 'pending') {
    return order
  }

  if (new Date(order.expiresAt).getTime() > Date.now()) {
    return order
  }

  const nextOrder: RechargeOrder = {
    ...order,
    status: 'closed',
    providerMessage: order.providerMessage || '订单已过期',
    updatedAt: new Date().toISOString(),
  }
  replaceRechargeOrder(workspace, nextOrder)
  return nextOrder
}

export async function getBillingCatalog() {
  return {
    providers: getPaymentProviderStatuses(),
    packages: RECHARGE_PACKAGES,
  }
}

export async function hydrateBillingWorkspace(workspace: WorkspaceState): Promise<WorkspaceState> {
  if (!isDatabaseEnabled()) {
    return workspace
  }

  const [orders, rechargePointLogs] = await Promise.all([
    listStoredRechargeOrdersForUser(workspace.user.id),
    listStoredRechargePointLogsForUser(workspace.user.id),
  ])

  const localRechargePoints = (workspace.user.pointLogs ?? [])
    .filter((item) => item.type === 'recharge')
    .reduce((total, item) => total + item.amount, 0)
  const basePoints = Math.max(0, workspace.user.points - localRechargePoints)
  const dbRechargePoints = rechargePointLogs.reduce((total, item) => total + item.amount, 0)
  const nonRechargeLogs = (workspace.user.pointLogs ?? []).filter((item) => item.type !== 'recharge')
  const pointLogs = [...rechargePointLogs, ...nonRechargeLogs]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())

  return {
    ...workspace,
    user: {
      ...workspace.user,
      points: basePoints + dbRechargePoints,
      pointLogs,
    },
    paymentOrders: orders,
  }
}

export async function listRechargePaymentOrders(limit = 50) {
  const workspace = await readWorkspace()
  const orders = workspace.paymentOrders
    .slice(0, limit)

  return {
    orders,
    summary: {
      total: orders.length,
      pending: orders.filter((item) => item.status === 'pending').length,
      paid: orders.filter((item) => item.status === 'paid').length,
      totalAmountFen: orders
        .filter((item) => item.status === 'paid')
        .reduce((total, item) => total + item.amountFen, 0),
      totalPoints: orders
        .filter((item) => item.status === 'paid')
        .reduce((total, item) => total + item.points, 0),
    },
  }
}

export async function createRechargePaymentOrder(payload: {
  channel: PaymentProvider
  packageId: string
}) {
  const provider = getPaymentProviderStatuses().find((item) => item.id === payload.channel)
  if (!provider?.enabled) {
    throw new AppError(provider?.reason || '当前支付通道未启用。', 400, 'PAYMENT_PROVIDER_DISABLED')
  }

  const rechargePackage = getRechargePackage(payload.packageId)
  const workspace = await readWorkspace()
  const now = new Date().toISOString()
  const outTradeNo = `LV${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  const title = `LawVerify ${rechargePackage.points} 积分充值`
  const description = `${rechargePackage.title} - ${rechargePackage.points} 积分`
  const gatewayOrder = await createGatewayRechargeOrder(payload.channel, {
    outTradeNo,
    title,
    description,
    amountFen: rechargePackage.amountFen,
  })

  let order: RechargeOrder = {
    id: createId('recharge-order'),
    userId: workspace.user.id,
    packageId: rechargePackage.id,
    channel: payload.channel,
    title,
    description,
    amountFen: rechargePackage.amountFen,
    points: rechargePackage.points,
    outTradeNo,
    status: 'pending',
    qrCodeContent: gatewayOrder.qrCodeContent,
    paymentUrl: gatewayOrder.paymentUrl,
    providerOrderId: gatewayOrder.providerOrderId,
    providerMessage: gatewayOrder.providerMessage,
    createdAt: now,
    updatedAt: now,
    expiresAt: gatewayOrder.expiresAt ?? new Date(Date.now() + 1000 * 60 * 30).toISOString(),
  }

  appendRechargeOrder(workspace, order)
  if (isDatabaseEnabled()) {
    try {
      order = await upsertStoredRechargeOrder(workspace, order)
      await recordAuditEvent({
        action: 'billing.order.created',
        entityType: 'payment_order',
        entityId: order.id,
        metadata: {
          outTradeNo: order.outTradeNo,
          channel: order.channel,
          packageId: order.packageId,
          amountFen: order.amountFen,
          points: order.points,
        },
      })
      replaceRechargeOrder(workspace, order)
    } catch {
      // Fallback to workspace persistence in development when database is unavailable.
    }
  }
  await writeWorkspace(workspace)

  return {
    workspace: await readWorkspace(),
    order,
    providers: getPaymentProviderStatuses(),
    packages: RECHARGE_PACKAGES,
  }
}

export async function getRechargePaymentOrder(orderId: string) {
  const workspace = await readWorkspace()
  let order = findRechargeOrder(workspace, orderId)
  const previousStatus = order.status
  order = closeExpiredOrder(workspace, order)

  if (order.status === 'pending') {
    const providerState = await queryGatewayRechargeOrder(order.channel, order.outTradeNo)
    const mergedOrder: RechargeOrder = {
      ...order,
      providerOrderId: providerState.providerOrderId ?? order.providerOrderId,
      providerMessage: providerState.providerMessage ?? order.providerMessage,
      updatedAt: new Date().toISOString(),
      paidAt: providerState.paidAt ?? order.paidAt,
      status: providerState.status,
    }

    replaceRechargeOrder(workspace, mergedOrder)
    order = mergedOrder

    if (providerState.status === 'paid') {
      order = markPaidAndCreditPoints(workspace, order, providerState.paidAt)
      if (isDatabaseEnabled()) {
        try {
          const pointLog = await createStoredRechargePointLog(workspace, order, order.paidAt ?? new Date().toISOString())
          if (pointLog) {
            order = {
              ...order,
              pointLogId: pointLog.id,
            }
            replaceRechargeOrder(workspace, order)
          }
        } catch {
          // Keep workspace state available even if database ledger persistence fails.
        }
      }
    }
  }

  if (isDatabaseEnabled()) {
    try {
      order = await upsertStoredRechargeOrder(workspace, order)
      replaceRechargeOrder(workspace, order)
      if (previousStatus !== order.status) {
        await recordAuditEvent({
          action: `billing.order.${order.status}`,
          entityType: 'payment_order',
          entityId: order.id,
          metadata: {
            outTradeNo: order.outTradeNo,
            channel: order.channel,
            amountFen: order.amountFen,
            points: order.points,
          },
        })
      }
    } catch {
      // Ignore database sync failures and keep local workspace usable.
    }
  }

  await writeWorkspace(workspace)
  return {
    workspace: await readWorkspace(),
    order,
  }
}
