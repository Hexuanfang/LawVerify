import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Client } from 'pg'
import { config } from '../config.js'
import { registerAccount, verifyToken } from '../commercial/auth-service.js'
import { getReferralSummary, rewardDevReferral } from '../referral-service.js'
import { eventBatchSchema, ingestProductEvents, setAnalyticsPreference } from '../analytics-service.js'
import { readDevStore, updateDevStore } from '../infrastructure/dev-store.js'
import { runMigrations } from '../infrastructure/migrations.js'
import { getPool } from '../infrastructure/postgres.js'
import { createApp } from '../app.js'
import { handlePaymentCallback } from '../billing-service.js'
import { billingPackages } from '../mock-data.js'
import type { AuthenticatedActor } from '../commercial/types.js'
import type { BillingOrder } from '../types.js'

const actorOf = (token: string): AuthenticatedActor => {
  const claims = verifyToken(token)
  return { userId: claims.sub, organizationId: claims.organizationId, membershipId: claims.membershipId,
    role: claims.role, email: claims.email, sessionId: claims.sessionId }
}
const signup = (tag: string, inviteCode?: string) => registerAccount({
  organizationName: `测试机构-${tag}`, ownerName: '测试律师', email: `${tag}@example.test`, password: 'test-password-123', inviteCode,
})
const order = (overrides: Partial<BillingOrder> = {}): BillingOrder => ({
  id: randomUUID(), orderNo: randomUUID(), packageId: billingPackages[0].id, packageName: '测试积分包',
  amountFen: 2000, points: 100, channel: 'alipay', status: 'paid',
  providerOrderId: 'real-provider-id', qrCodeContent: '', createdAt: new Date().toISOString(), ...overrides,
})

test('邀请与埋点的隔离回归测试', async t => {
  const saved = { root: config.cloudServerRoot, database: config.DATABASE_URL, migrations: config.MIGRATIONS_DIR,
    enabled: config.REFERRAL_REWARDS_ENABLED, inviter: config.REFERRAL_INVITER_POINTS,
    invitee: config.REFERRAL_INVITEE_POINTS, minimum: config.REFERRAL_MIN_PAYMENT_FEN }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lawverify-referral-test-'))
  config.cloudServerRoot = temporary; config.DATABASE_URL = undefined
  config.REFERRAL_REWARDS_ENABLED = true; config.REFERRAL_INVITER_POINTS = 100; config.REFERRAL_INVITEE_POINTS = 50
  config.REFERRAL_MIN_PAYMENT_FEN = 1000
  let cleanupDatabase: (() => Promise<void>) | undefined
  try {
    const inviter = actorOf((await signup('inviter')).token)
    const invitation = await getReferralSummary(inviter)
    const registration = await signup('invitee', invitation.code)
    const invitee = actorOf(registration.token)
    await t.test('无效邀请码使整个注册回滚，不留下账号或赠送积分', async () => {
      const before = await readDevStore()
      await assert.rejects(signup('invalid', '0000000000000000'), /邀请码无效/)
      const after = await readDevStore()
      assert.equal(after.users.length, before.users.length)
      assert.equal(after.pointLedgerEntries.length, before.pointLedgerEntries.length)
    })
    await t.test('未付款、低额付款及模拟付款不发奖', async () => {
      for (const sample of [order({ status: 'pending' }), order({ amountFen: 999 }), order({ providerOrderId: 'dev-alipay-123' })]) {
        await updateDevStore(store => rewardDevReferral(store, invitee.userId, sample))
      }
      assert.equal((await getReferralSummary(inviter)).earnedPoints, 0)
    })
    await t.test('并发重复入账和第二次充值仅奖励一次，账本和余额一致', async () => {
      const paid = order()
      await Promise.all(Array.from({ length: 8 }, () => updateDevStore(store => rewardDevReferral(store, invitee.userId, paid))))
      await updateDevStore(store => rewardDevReferral(store, invitee.userId, order()))
      const store = await readDevStore()
      assert.equal(store.pointLedgerEntries.filter(e => e.metadata?.source === 'referral_reward').length, 2)
      assert.equal(store.pointAccounts.find(a => a.userId === inviter.userId)?.balancePoints, 400)
      assert.equal(store.pointAccounts.find(a => a.userId === invitee.userId)?.balancePoints, 350)
      assert.equal((await getReferralSummary(inviter)).earnedPoints, 100)
    })
    await t.test('默认不采集，事件去重，拒绝正文和任意事件字段，撤回授权清除记录', async () => {
      const event = { id: randomUUID(), name: 'legal.verify' as const, surface: 'desktop' as const, outcome: 'success' as const, durationMs: 100 }
      assert.equal((await ingestProductEvents(invitee, [event])).accepted, 0)
      await setAnalyticsPreference(invitee, true)
      assert.equal((await ingestProductEvents(invitee, [event])).accepted, 1)
      assert.equal((await ingestProductEvents(invitee, [event])).accepted, 0)
      assert.equal(eventBatchSchema.safeParse({ events: [{ ...event, text: '案件正文' }] }).success, false)
      assert.equal(eventBatchSchema.safeParse({ events: [{ ...event, name: 'arbitrary.event' }] }).success, false)
      await setAnalyticsPreference(invitee, false)
      assert.equal((await readDevStore()).productEvents.length, 0)
    })
    await t.test('真实 HTTP 路由鉴权、参数验证和管理员隔离', async () => {
      const server = createApp().listen(0, '127.0.0.1')
      await new Promise<void>(resolve => server.once('listening', resolve))
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const base = `http://127.0.0.1:${address.port}`
      const headers = { Authorization: `Bearer ${registration.token}`, 'Content-Type': 'application/json' }
      try {
        assert.equal((await fetch(`${base}/api/account/referrals`)).status, 401)
        assert.equal((await fetch(`${base}/api/admin/analytics`, { headers })).status, 403)
        assert.equal((await fetch(`${base}/api/account/events`, { method: 'POST', headers, body: JSON.stringify({ events: [{
          id: randomUUID(), name: 'legal.verify', surface: 'desktop', outcome: 'success', durationMs: 10, caseName: '禁止上传',
        }] }) })).status, 400)
        const response = await fetch(`${base}/api/account/referrals`, { headers })
        assert.equal(response.status, 200)
      } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) }
    })
    await t.test('PostgreSQL 注册、支付回调与奖励事务闭环', { skip: !process.argv.includes('--postgres') }, async () => {
      assert.ok(saved.database, '本地数据库未配置')
      const target = new URL(saved.database)
      assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), '仅允许在本地 PostgreSQL 的隔离 schema 内测试')
      const control = new Client({ connectionString: saved.database })
      await control.connect()
      const schema = `lawverify_test_${randomUUID().replace(/-/g, '')}`
      await control.query(`CREATE SCHEMA "${schema}"`)
      target.searchParams.set('options', `-c search_path=${schema}`)
      config.DATABASE_URL = target.toString(); config.MIGRATIONS_DIR = path.join(saved.root, 'migrations')
      cleanupDatabase = async () => {
        await getPool().end()
        await control.query(`DROP SCHEMA "${schema}" CASCADE`)
        await control.end()
      }
      await runMigrations()
      const inviter = actorOf((await signup('pg-inviter')).token)
      const code = (await getReferralSummary(inviter)).code
      const invitee = actorOf((await signup('pg-invitee', code)).token)
      await assert.rejects(signup('pg-invalid', '0000000000000000'))
      assert.equal(Number((await getPool().query("SELECT COUNT(*) FROM users WHERE email = 'pg-invalid@example.test'")).rows[0].count), 0)
      assert.equal(Number((await getPool().query('SELECT COUNT(*) FROM organizations')).rows[0].count), 2)
      const paid = order({ points: billingPackages[0].points, amountFen: Math.max(2000, billingPackages[0].amountFen) })
      await getPool().query(`INSERT INTO payment_orders
        (id, organization_id, commercial_user_id, workspace_user_id, package_id, channel, title, amount_fen, points, out_trade_no, status, expires_at, qr_code_content)
        VALUES ($1,$2,$3::uuid,$3::text,$4,'alipay','测试付款',$5,$6,$7,'pending',NOW() + INTERVAL '1 day','')`,
        [paid.id, invitee.organizationId, invitee.userId, paid.packageId, paid.amountFen, paid.points, paid.orderNo])
      await Promise.all(Array.from({ length: 6 }, () => handlePaymentCallback({
        provider: 'alipay', outTradeNo: paid.orderNo, providerOrderId: 'real-test-paid',
        status: 'paid', paidAt: new Date().toISOString(), payload: { isolatedTest: true },
      })))
      const rows = (await getPool().query('SELECT user_id, balance_points FROM point_accounts')).rows
      assert.equal(rows.find(r => r.user_id === inviter.userId)?.balance_points, 400)
      assert.equal(rows.find(r => r.user_id === invitee.userId)?.balance_points, 350 + paid.points)
      assert.equal(Number((await getPool().query("SELECT COUNT(*) FROM point_ledger_entries WHERE metadata->>'source' = 'referral_reward'")).rows[0].count), 2)
      assert.equal((await getReferralSummary(inviter)).rewarded, 1)
      const event = { id: randomUUID(), name: 'case.search' as const, surface: 'web' as const, outcome: 'success' as const, durationMs: 50 }
      await setAnalyticsPreference(invitee, true)
      const counts = await Promise.all(Array.from({ length: 6 }, () => ingestProductEvents(invitee, [event])))
      assert.equal(counts.reduce((sum, r) => sum + r.accepted, 0), 1)
      await setAnalyticsPreference(invitee, false)
      assert.equal(Number((await getPool().query('SELECT COUNT(*) FROM product_events')).rows[0].count), 0)
    })
  } finally {
    if (cleanupDatabase) await cleanupDatabase()
    config.cloudServerRoot = saved.root; config.DATABASE_URL = saved.database; config.MIGRATIONS_DIR = saved.migrations
    config.REFERRAL_REWARDS_ENABLED = saved.enabled; config.REFERRAL_INVITER_POINTS = saved.inviter
    config.REFERRAL_INVITEE_POINTS = saved.invitee; config.REFERRAL_MIN_PAYMENT_FEN = saved.minimum
    await rm(temporary, { recursive: true, force: true })
  }
})
