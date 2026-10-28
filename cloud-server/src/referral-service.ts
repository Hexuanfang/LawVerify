import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { config } from './config.js'
import { AppError } from './core/app-error.js'
import type { AuthenticatedActor } from './commercial/types.js'
import { readDevStore, updateDevStore, type DevStoreShape } from './infrastructure/dev-store.js'
import { getPool, isDatabaseEnabled } from './infrastructure/postgres.js'
import type { BillingOrder } from './types.js'

export function bindDevReferral(store: DevStoreShape, inviteeId: string, organizationId: string, code?: string) {
  if (!code) return
  const inviter = store.referralCodes.find(c => c.code === code.trim().toUpperCase())
  if (!inviter || inviter.userId === inviteeId || inviter.organizationId === organizationId) {
    throw new AppError('邀请码无效。', 400, 'REFERRAL_CODE_INVALID')
  }
  store.referrals.push({ inviteeId, inviteeOrganizationId: organizationId, inviterId: inviter.userId,
    inviterOrganizationId: inviter.organizationId, createdAt: new Date().toISOString() })
}

export async function bindStoredReferral(client: PoolClient, inviteeId: string, organizationId: string, code?: string) {
  if (!code) return
  const result = await client.query<{ user_id: string; organization_id: string }>(
    'SELECT user_id, organization_id FROM referral_codes WHERE code = $1', [code.trim().toUpperCase()])
  const inviter = result.rows[0]
  if (!inviter || inviter.user_id === inviteeId || inviter.organization_id === organizationId) {
    throw new AppError('邀请码无效。', 400, 'REFERRAL_CODE_INVALID')
  }
  await client.query(`INSERT INTO account_referrals (invitee_id, invitee_organization_id, inviter_id, inviter_organization_id)
    VALUES ($1, $2, $3, $4)`, [inviteeId, organizationId, inviter.user_id, inviter.organization_id])
}

function eligible(order: BillingOrder) {
  return config.REFERRAL_REWARDS_ENABLED && order.status === 'paid'
    && order.amountFen >= config.REFERRAL_MIN_PAYMENT_FEN
    && !!order.providerOrderId && !order.providerOrderId.startsWith('dev-')
    && order.providerMessage !== 'DEVELOPMENT_SIMULATED_PAID'
}

export function rewardDevReferral(store: DevStoreShape, inviteeId: string, order: BillingOrder) {
  if (!eligible(order)) return
  const referral = store.referrals.find(r => r.inviteeId === inviteeId && !r.rewardedAt)
  if (!referral) return
  for (const [userId, organizationId, points, side] of [
    [referral.inviterId, referral.inviterOrganizationId, config.REFERRAL_INVITER_POINTS, 'inviter'],
    [referral.inviteeId, referral.inviteeOrganizationId, config.REFERRAL_INVITEE_POINTS, 'invitee'],
  ] as const) {
    const operationKey = `referral:${inviteeId}:${side}`
    if (points <= 0 || store.pointLedgerEntries.some(e => e.operationKey === operationKey)) continue
    const account = store.pointAccounts.find(a => a.userId === userId && a.organizationId === organizationId)
    if (!account) throw new AppError('邀请积分账户不存在。', 409, 'REFERRAL_ACCOUNT_MISSING')
    account.balancePoints += points
    store.pointLedgerEntries.unshift({ id: `point-${randomUUID()}`, userId, organizationId,
      entryType: 'adjust', operationKey, changePoints: points, note: '邀请奖励',
      metadata: { source: 'referral_reward', qualifyingOrderId: order.id }, createdAt: new Date().toISOString() })
  }
  Object.assign(referral, { rewardedAt: new Date().toISOString(), rewardOrderId: order.id,
    inviterPoints: config.REFERRAL_INVITER_POINTS, inviteePoints: config.REFERRAL_INVITEE_POINTS })
}

export async function rewardStoredReferral(client: PoolClient, inviteeId: string, order: BillingOrder) {
  if (!eligible(order)) return
  const result = await client.query<{ inviter_id: string; inviter_organization_id: string; invitee_organization_id: string }>(
    'SELECT * FROM account_referrals WHERE invitee_id = $1 AND rewarded_at IS NULL FOR UPDATE', [inviteeId])
  const referral = result.rows[0]
  if (!referral) return
  // Lock account rows in a stable order for concurrent rewards to shared inviters.
  const recipients = [
    { user: referral.inviter_id, org: referral.inviter_organization_id, points: config.REFERRAL_INVITER_POINTS, side: 'inviter' },
    { user: inviteeId, org: referral.invitee_organization_id, points: config.REFERRAL_INVITEE_POINTS, side: 'invitee' },
  ].sort((a, b) => a.user.localeCompare(b.user))
  for (const recipient of recipients) {
    if (!recipient.points) continue
    await client.query(`INSERT INTO point_accounts (organization_id, user_id, balance_points) VALUES ($1, $2, 0)
      ON CONFLICT (organization_id, user_id) DO NOTHING`, [recipient.org, recipient.user])
    await client.query('SELECT user_id FROM point_accounts WHERE organization_id = $1 AND user_id = $2 FOR UPDATE', [recipient.org, recipient.user])
    const ledger = await client.query(`INSERT INTO point_ledger_entries
      (organization_id, commercial_user_id, workspace_user_id, entry_type, operation_key, change_points, note, metadata)
      VALUES ($1, $2::uuid, $2::text, 'adjust', $3, $4, '邀请奖励', $5::jsonb)
      ON CONFLICT (operation_key) WHERE operation_key IS NOT NULL DO NOTHING RETURNING id`,
      [recipient.org, recipient.user, `referral:${inviteeId}:${recipient.side}`, recipient.points,
        JSON.stringify({ source: 'referral_reward', qualifyingOrderId: order.id })])
    if (ledger.rowCount) await client.query(`UPDATE point_accounts SET balance_points = balance_points + $3, updated_at = NOW()
      WHERE organization_id = $1 AND user_id = $2`, [recipient.org, recipient.user, recipient.points])
  }
  await client.query(`UPDATE account_referrals SET reward_order_id = $2, rewarded_at = NOW(), inviter_points = $3, invitee_points = $4
    WHERE invitee_id = $1`, [inviteeId, order.id, config.REFERRAL_INVITER_POINTS, config.REFERRAL_INVITEE_POINTS])
}

export async function getReferralSummary(actor: AuthenticatedActor) {
  let code: string, invited: number, rewarded: number, earnedPoints: number
  if (!isDatabaseEnabled()) {
    code = await updateDevStore(store => {
      let item = store.referralCodes.find(c => c.userId === actor.userId)
      if (!item) {
        item = { userId: actor.userId, organizationId: actor.organizationId, code: randomBytes(8).toString('hex').toUpperCase() }
        store.referralCodes.push(item)
      }
      return item.code
    })
    const store = await readDevStore()
    const referrals = store.referrals.filter(r => r.inviterId === actor.userId)
    invited = referrals.length; rewarded = referrals.filter(r => r.rewardedAt).length
    earnedPoints = referrals.reduce((n, r) => n + (r.inviterPoints ?? 0), 0)
  } else {
    const client = await getPool().connect()
    try {
      await client.query(`INSERT INTO referral_codes (user_id, organization_id, code) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO NOTHING`, [actor.userId, actor.organizationId, randomBytes(8).toString('hex').toUpperCase()])
      code = (await client.query<{ code: string }>('SELECT code FROM referral_codes WHERE user_id = $1', [actor.userId])).rows[0].code
      const counts = (await client.query<{ invited: string; rewarded: string; earned: string }>(`SELECT COUNT(*) AS invited,
        COUNT(rewarded_at) AS rewarded, COALESCE(SUM(inviter_points), 0) AS earned FROM account_referrals WHERE inviter_id = $1`, [actor.userId])).rows[0]
      invited = Number(counts.invited); rewarded = Number(counts.rewarded); earnedPoints = Number(counts.earned)
    } finally { client.release() }
  }
  return { code, inviteUrl: `${config.CLOUD_PUBLIC_BASE_URL.replace(/\/$/, '')}/register?invite=${code}`,
    invited, rewarded, earnedPoints, enabled: config.REFERRAL_REWARDS_ENABLED,
    inviterPoints: config.REFERRAL_INVITER_POINTS, inviteePoints: config.REFERRAL_INVITEE_POINTS,
    minPaymentFen: config.REFERRAL_MIN_PAYMENT_FEN }
}
