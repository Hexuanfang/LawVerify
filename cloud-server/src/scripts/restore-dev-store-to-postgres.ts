import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PoolClient } from 'pg'

import { config } from '../config.js'
import { getPool, isDatabaseEnabled } from '../infrastructure/postgres.js'

type DevStoreUser = {
  id: string
  email: string
  passwordHash: string
  name: string
  currentSessionId?: string | null
  status: 'active'
}

type DevStoreOrganization = {
  id: string
  name: string
  slug: string
  status: 'active'
}

type DevStoreMembership = {
  id: string
  organizationId: string
  userId: string
  role: 'owner' | 'admin' | 'lawyer' | 'reviewer' | 'assistant' | 'viewer'
  title: string | null
  status: 'active'
  createdAt: string
}

type DevStorePointAccount = {
  organizationId: string
  userId: string
  balancePoints: number
}

type DevStorePointLedgerEntry = {
  id: string
  organizationId: string
  userId: string
  orderId?: string
  entryType: 'recharge' | 'consume' | 'refund' | 'adjust' | 'freeze' | 'unfreeze'
  actionType?: string
  operationKey?: string
  relatedEntryId?: string
  changePoints: number
  note: string
  metadata?: Record<string, unknown>
  createdAt: string
}

type DevStoreOrder = {
  id: string
  orderNo: string
  packageId: string
  packageName: string
  amountFen: number
  points: number
  channel: 'alipay' | 'wechat'
  status: 'pending' | 'paid' | 'closed' | 'failed'
  qrCodeContent: string
  paymentUrl?: string
  providerOrderId?: string
  providerMessage?: string
  pointLogId?: string
  createdAt: string
  updatedAt?: string
  expiresAt?: string
  paidAt?: string
  organizationId: string
  userId: string
}

type DevStoreShape = {
  users: DevStoreUser[]
  organizations: DevStoreOrganization[]
  memberships: DevStoreMembership[]
  pointAccounts: DevStorePointAccount[]
  pointLedgerEntries: DevStorePointLedgerEntry[]
  paymentOrders: DevStoreOrder[]
}

function getDevStorePath() {
  return path.join(config.cloudServerRoot, '.data', 'dev-store.json')
}

function makePairKey(left: string, right: string) {
  return `${left}::${right}`
}

function normalizeUuidLike(value: string | undefined | null) {
  if (!value) {
    return null
  }

  const normalized = value.trim()
  const prefixedUuidMatch = normalized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  if (prefixedUuidMatch) {
    return prefixedUuidMatch[0]
  }

  return normalized
}

async function loadDevStore() {
  const storePath = getDevStorePath()
  const content = await readFile(storePath, 'utf8')
  return JSON.parse(content) as DevStoreShape
}

async function queryExistingUsers(client: PoolClient) {
  const result = await client.query<{ id: string; email: string; created_at: string }>(
    'SELECT id, email, created_at::text FROM users',
  )
  return new Map(result.rows.map((row) => [row.email.trim().toLowerCase(), row]))
}

async function queryExistingOrganizations(client: PoolClient) {
  const result = await client.query<{ id: string; slug: string; created_at: string }>(
    'SELECT id, slug, created_at::text FROM organizations',
  )
  return new Map(result.rows.map((row) => [row.slug, row]))
}

async function queryExistingMemberships(client: PoolClient) {
  const result = await client.query<{ organization_id: string; user_id: string }>(
    'SELECT organization_id, user_id FROM organization_memberships',
  )
  return new Set(result.rows.map((row) => makePairKey(row.organization_id, row.user_id)))
}

async function queryExistingPointAccounts(client: PoolClient) {
  const result = await client.query<{ organization_id: string; user_id: string; balance_points: number }>(
    'SELECT organization_id, user_id, balance_points FROM point_accounts',
  )
  return new Map(result.rows.map((row) => [makePairKey(row.organization_id, row.user_id), row.balance_points]))
}

async function queryExistingOrders(client: PoolClient) {
  const result = await client.query<{ id: string; out_trade_no: string }>('SELECT id, out_trade_no FROM payment_orders')
  return new Map(result.rows.map((row) => [row.out_trade_no, row.id]))
}

async function queryExistingLedgerState(client: PoolClient) {
  const ids = new Set<string>()
  const operationKeys = new Set<string>()
  const orderEntryKeys = new Set<string>()

  const result = await client.query<{
    id: string
    operation_key: string | null
    order_id: string | null
    entry_type: string
  }>('SELECT id, operation_key, order_id, entry_type FROM point_ledger_entries')

  for (const row of result.rows) {
    ids.add(row.id)
    if (row.operation_key) {
      operationKeys.add(row.operation_key)
    }
    if (row.order_id) {
      orderEntryKeys.add(makePairKey(row.order_id, row.entry_type))
    }
  }

  return { ids, operationKeys, orderEntryKeys }
}

async function main() {
  if (!isDatabaseEnabled()) {
    throw new Error('未配置 DATABASE_URL，无法恢复旧用户数据。')
  }

  const store = await loadDevStore()
  const usersById = new Map(store.users.map((user) => [user.id, user]))
  const orgsById = new Map(store.organizations.map((org) => [org.id, org]))

  const earliestMembershipByUser = new Map<string, string>()
  const earliestMembershipByOrg = new Map<string, string>()

  for (const membership of store.memberships) {
    const userCreatedAt = earliestMembershipByUser.get(membership.userId)
    if (!userCreatedAt || userCreatedAt > membership.createdAt) {
      earliestMembershipByUser.set(membership.userId, membership.createdAt)
    }

    const orgCreatedAt = earliestMembershipByOrg.get(membership.organizationId)
    if (!orgCreatedAt || orgCreatedAt > membership.createdAt) {
      earliestMembershipByOrg.set(membership.organizationId, membership.createdAt)
    }
  }

  const pool = getPool()
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const existingUsers = await queryExistingUsers(client)
    const existingOrganizations = await queryExistingOrganizations(client)
    const existingMemberships = await queryExistingMemberships(client)
    const existingPointAccounts = await queryExistingPointAccounts(client)
    const existingOrders = await queryExistingOrders(client)
    const existingLedgerState = await queryExistingLedgerState(client)

    const userIdMap = new Map<string, string>()
    const organizationIdMap = new Map<string, string>()
    const orderIdMap = new Map<string, string>()

    const summary = {
      insertedUsers: 0,
      insertedOrganizations: 0,
      insertedMemberships: 0,
      upsertedPointAccounts: 0,
      insertedPaymentOrders: 0,
      insertedPointLedgerEntries: 0,
      mappedExistingUsers: 0,
      mappedExistingOrganizations: 0,
    }

    for (const user of store.users) {
      const normalizedEmail = user.email.trim().toLowerCase()
      const existingUser = existingUsers.get(normalizedEmail)
      if (existingUser) {
        const historicalCreatedAt = earliestMembershipByUser.get(user.id)
        if (historicalCreatedAt && historicalCreatedAt < existingUser.created_at) {
          await client.query('UPDATE users SET created_at = $1 WHERE id = $2', [historicalCreatedAt, existingUser.id])
        }
        userIdMap.set(user.id, existingUser.id)
        summary.mappedExistingUsers += 1
        continue
      }

      const createdAt = earliestMembershipByUser.get(user.id) ?? new Date().toISOString()
      await client.query(
        `
          INSERT INTO users (id, email, password_hash, name, status, created_at, updated_at, current_session_id)
          VALUES ($1, $2, $3, $4, $5, $6, $6, NULL)
        `,
        [user.id, normalizedEmail, user.passwordHash, user.name, user.status, createdAt],
      )

      existingUsers.set(normalizedEmail, { id: user.id, email: normalizedEmail, created_at: createdAt })
      userIdMap.set(user.id, user.id)
      summary.insertedUsers += 1
    }

    for (const organization of store.organizations) {
      const existingOrganization = existingOrganizations.get(organization.slug)
      if (existingOrganization) {
        const historicalCreatedAt = earliestMembershipByOrg.get(organization.id)
        if (historicalCreatedAt && historicalCreatedAt < existingOrganization.created_at) {
          await client.query('UPDATE organizations SET created_at = $1 WHERE id = $2', [
            historicalCreatedAt,
            existingOrganization.id,
          ])
        }
        organizationIdMap.set(organization.id, existingOrganization.id)
        summary.mappedExistingOrganizations += 1
        continue
      }

      const createdAt = earliestMembershipByOrg.get(organization.id) ?? new Date().toISOString()
      await client.query(
        `
          INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $5)
        `,
        [organization.id, organization.name, organization.slug, organization.status, createdAt],
      )

      existingOrganizations.set(organization.slug, { id: organization.id, slug: organization.slug, created_at: createdAt })
      organizationIdMap.set(organization.id, organization.id)
      summary.insertedOrganizations += 1
    }

    for (const membership of store.memberships) {
      const mappedUserId = userIdMap.get(membership.userId)
      const mappedOrganizationId = organizationIdMap.get(membership.organizationId)
      if (!mappedUserId || !mappedOrganizationId) {
        continue
      }

      const membershipKey = makePairKey(mappedOrganizationId, mappedUserId)
      if (existingMemberships.has(membershipKey)) {
        continue
      }

      await client.query(
        `
          INSERT INTO organization_memberships (
            id, organization_id, user_id, role, title, status, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
          ON CONFLICT (organization_id, user_id) DO NOTHING
        `,
        [
          membership.id,
          mappedOrganizationId,
          mappedUserId,
          membership.role,
          membership.title,
          membership.status,
          membership.createdAt,
        ],
      )

      existingMemberships.add(membershipKey)
      summary.insertedMemberships += 1
    }

    for (const pointAccount of store.pointAccounts) {
      const mappedUserId = userIdMap.get(pointAccount.userId)
      const mappedOrganizationId = organizationIdMap.get(pointAccount.organizationId)
      if (!mappedUserId || !mappedOrganizationId) {
        continue
      }

      const pointAccountKey = makePairKey(mappedOrganizationId, mappedUserId)
      const existingBalance = existingPointAccounts.get(pointAccountKey) ?? null
      const nextBalance = existingBalance == null
        ? pointAccount.balancePoints
        : Math.max(existingBalance, pointAccount.balancePoints)

      await client.query(
        `
          INSERT INTO point_accounts (organization_id, user_id, balance_points, created_at, updated_at)
          VALUES ($1, $2, $3, NOW(), NOW())
          ON CONFLICT (organization_id, user_id) DO UPDATE
          SET balance_points = GREATEST(point_accounts.balance_points, EXCLUDED.balance_points),
              updated_at = NOW()
        `,
        [mappedOrganizationId, mappedUserId, nextBalance],
      )

      existingPointAccounts.set(pointAccountKey, nextBalance)
      summary.upsertedPointAccounts += 1
    }

    for (const order of store.paymentOrders.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())) {
      const mappedUserId = userIdMap.get(order.userId)
      const mappedOrganizationId = organizationIdMap.get(order.organizationId)
      if (!mappedUserId || !mappedOrganizationId) {
        continue
      }

      const existingOrderId = existingOrders.get(order.orderNo)
      if (existingOrderId) {
        orderIdMap.set(order.id, existingOrderId)
        continue
      }

      const sourceUser = usersById.get(order.userId)
      await client.query(
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
            created_at,
            updated_at,
            expires_at,
            paid_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24
          )
          ON CONFLICT (out_trade_no) DO NOTHING
        `,
        [
          order.id,
          mappedOrganizationId,
          mappedUserId,
          mappedUserId,
          sourceUser?.email ?? null,
          sourceUser?.name ?? null,
          order.packageId,
          order.channel,
          order.packageName,
          '',
          order.amountFen,
          order.points,
          order.orderNo,
          order.status,
          order.qrCodeContent || null,
          order.paymentUrl ?? null,
          order.providerOrderId ?? null,
          order.providerMessage ?? null,
          normalizeUuidLike(order.pointLogId),
          JSON.stringify({ restoredFrom: 'dev-store' }),
          order.createdAt,
          order.updatedAt ?? order.createdAt,
          order.expiresAt ?? order.createdAt,
          order.paidAt ?? null,
        ],
      )

      existingOrders.set(order.orderNo, order.id)
      orderIdMap.set(order.id, order.id)
      summary.insertedPaymentOrders += 1
    }

    const sortedLedgerEntries = [...store.pointLedgerEntries].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    )

    for (const entry of sortedLedgerEntries) {
      const mappedUserId = userIdMap.get(entry.userId)
      const mappedOrganizationId = organizationIdMap.get(entry.organizationId)
      if (!mappedUserId || !mappedOrganizationId) {
        continue
      }

      const mappedOrderId = entry.orderId ? orderIdMap.get(entry.orderId) ?? null : null
      const orderEntryKey = mappedOrderId ? makePairKey(mappedOrderId, entry.entryType) : null
      const normalizedLedgerId = normalizeUuidLike(entry.id)
      if (!normalizedLedgerId) {
        continue
      }

      if (existingLedgerState.ids.has(normalizedLedgerId)) {
        continue
      }
      if (entry.operationKey && existingLedgerState.operationKeys.has(entry.operationKey)) {
        continue
      }
      if (orderEntryKey && existingLedgerState.orderEntryKeys.has(orderEntryKey)) {
        continue
      }

      const sourceUser = usersById.get(entry.userId)
      const normalizedRelatedEntryId = normalizeUuidLike(entry.relatedEntryId)
      const relatedEntryId = normalizedRelatedEntryId && existingLedgerState.ids.has(normalizedRelatedEntryId)
        ? normalizedRelatedEntryId
        : null

      await client.query(
        `
          INSERT INTO point_ledger_entries (
            id,
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
            created_at,
            operation_key,
            action_type,
            related_entry_id
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
        `,
        [
          normalizedLedgerId,
          mappedOrganizationId,
          mappedUserId,
          mappedUserId,
          sourceUser?.email ?? null,
          sourceUser?.name ?? null,
          mappedOrderId,
          entry.entryType,
          entry.changePoints,
          entry.note,
          JSON.stringify(entry.metadata ?? {}),
          entry.createdAt,
          entry.operationKey ?? null,
          entry.actionType ?? null,
          relatedEntryId,
        ],
      )

      existingLedgerState.ids.add(normalizedLedgerId)
      if (entry.operationKey) {
        existingLedgerState.operationKeys.add(entry.operationKey)
      }
      if (orderEntryKey) {
        existingLedgerState.orderEntryKeys.add(orderEntryKey)
      }
      summary.insertedPointLedgerEntries += 1
    }

    await client.query('COMMIT')
    console.log(JSON.stringify(summary, null, 2))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
