import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

import { createApp } from '../app.js'
import { config } from '../config.js'
import { runMigrations } from '../infrastructure/migrations.js'
import { getPool, query } from '../infrastructure/postgres.js'

const require = createRequire(import.meta.url)
const sdk = require('@alicloud/dysmsapi20170525') as typeof import('@alicloud/dysmsapi20170525')

test('手机号注册与登录复用账号会话，短信挑战限制用途、频率与重放', async () => {
  const database = process.env.LAWVERIFY_PHONE_TEST_DATABASE_URL
  assert.ok(database, '需要独立的 PostgreSQL 测试库')
  const databaseUrl = new URL(database)
  assert.equal(databaseUrl.hostname, '127.0.0.1')
  assert.equal(databaseUrl.pathname, '/lawverify_phone_test')
  config.DATABASE_URL = database
  config.ALIYUN_SMS_SIGN_NAME = '测试签名'
  config.ALIYUN_SMS_TEMPLATE_CODE = 'SMS_123'
  config.SMS_OTP_SECRET = 'phone-auth-regression-test-key-only'
  config.SMS_TRUST_PROXY_CIDRS = '127.0.0.1/32'
  const sent = new Map<string, string>()
  const original = sdk.default.prototype.sendSms
  sdk.default.prototype.sendSms = async request => {
    assert.equal(request.signName, '测试签名')
    assert.equal(request.templateCode, 'SMS_123')
    const { code } = JSON.parse(request.templateParam!) as { code: string }
    assert.match(code, /^[1-9]\d{5}$/)
    sent.set(request.phoneNumbers!, code)
    return new sdk.SendSmsResponse({ body: new sdk.SendSmsResponseBody({ code: 'OK' }) })
  }

  const app = createApp().listen(0, '127.0.0.1')
  try {
    await runMigrations()
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/account`
    const suffix = Date.now().toString().slice(-8)
    async function request(path: string, body?: unknown, token?: string) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `2001:db8::${suffix.slice(0, 4)}:${suffix.slice(4)}`,
          ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, ...(await response.json()) }
    }
    const phone = `138${suffix}`
    const unverifiedContact = `139${suffix}`
    const email = `phone-regression-${suffix}@example.test`
    const credentials = { email, password: 'testing-password' }
    const details = { organizationName: '测试律所', ownerName: '测试用户' }
    const emailAccount = await request('/register', { ...details, ...credentials })
    assert.equal(emailAccount.status, 200)
    assert.equal((await request('/login', credentials)).data.user.id, emailAccount.data.user.id)
    await query('UPDATE users SET phone = $1 WHERE id = $2', [unverifiedContact, emailAccount.data.user.id])

    const sends = await Promise.all([1, 2].map(() => request('/sms/send', { phone, purpose: 'register' })))
    assert.deepEqual(sends.map(result => result.status).sort(), [200, 429])
    const { challengeId } = sends.find(result => result.status === 200)!.data
    const challenge = { phone, challengeId, code: sent.get(phone) }
    assert.equal((await request('/phone/login', challenge)).status, 400)
    assert.equal((await request('/phone/register', { ...details, ...challenge, code: '000000' })).status, 400)
    const badInvite = await request('/phone/register', { ...details, ...challenge, inviteCode: '0000000000000000' })
    assert.equal(badInvite.error.code, 'REFERRAL_CODE_INVALID')
    const signups = await Promise.all([1, 2].map(() => request('/phone/register', { ...details, ...challenge })))
    assert.deepEqual(signups.map(result => result.status).sort(), [200, 400])
    const { user, token } = signups.find(result => result.status === 200)!.data
    assert.notEqual(user.id, emailAccount.data.user.id)
    assert.match(user.email, /^[\w-]+@phone\.lawverify\.invalid$/)
    assert.equal(user.email.includes(phone), false)
    assert.equal((await request('/profile', undefined, token)).data.user.maskedPhone, `138****${phone.slice(-4)}`)
    assert.equal((await request('/me', undefined, token)).data.pointsBalance, 300)
    assert.equal((await request('/login', { email: user.email, password: 'testing-password' })).status, 401)
    assert.equal((await request('/register', { ...details, email: user.email, password: 'testing-password' })).status, 400)

    await query('UPDATE account_sms_challenges SET created_at = created_at - interval \'61 seconds\' WHERE id = $1', [challengeId])
    const loginCode = await request('/sms/send', { phone, purpose: 'login' })
    assert.equal(loginCode.status, 200)
    const loginData = { phone, challengeId: loginCode.data.challengeId, code: sent.get(phone) }
    await query('UPDATE account_sms_challenges SET created_at = created_at - interval \'61 seconds\' WHERE id = $1', [loginData.challengeId])
    const otherCode = await request('/sms/send', { phone, purpose: 'login' })
    assert.equal(otherCode.status, 200)
    const login = await request('/phone/login', loginData)
    assert.equal(login.status, 200)
    assert.equal(login.data.user.id, user.id)
    assert.equal((await request('/phone/login', loginData)).status, 400)
    assert.equal((await request('/phone/login', { phone, challengeId: otherCode.data.challengeId, code: sent.get(phone) })).status, 400)

    await query('UPDATE account_sms_challenges SET created_at = created_at - interval \'61 seconds\' WHERE id = $1', [otherCode.data.challengeId])
    const duplicate = await request('/sms/send', { phone, purpose: 'register' })
    assert.equal(duplicate.status, 200)
    assert.equal((await request('/phone/register', { ...details, phone, challengeId: duplicate.data.challengeId,
      code: sent.get(phone) })).status, 409)

    const denied = await request('/sms/send', { phone: unverifiedContact, purpose: 'login' })
    assert.equal(denied.status, 200)
    assert.equal((await request('/phone/login', { phone: unverifiedContact, challengeId: denied.data.challengeId,
      code: sent.get(unverifiedContact) })).status, 401)

    const expiredPhone = `137${suffix}`
    const expired = await request('/sms/send', { phone: expiredPhone, purpose: 'login' })
    await query("UPDATE account_sms_challenges SET sent_at = NOW() - interval '6 minutes' WHERE id = $1", [expired.data.challengeId])
    assert.equal((await request('/phone/login', { phone: expiredPhone, challengeId: expired.data.challengeId,
      code: sent.get(expiredPhone) })).status, 400)

    const lockedPhone = `136${suffix}`
    const locked = await request('/sms/send', { phone: lockedPhone, purpose: 'register' })
    const lockedInput = { ...details, phone: lockedPhone, challengeId: locked.data.challengeId }
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await request('/phone/register', { ...lockedInput, code: '000000' })).status, 400)
    }
    assert.equal((await request('/phone/register', { ...lockedInput, code: sent.get(lockedPhone) })).status, 400)
  } finally {
    sdk.default.prototype.sendSms = original
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()))
    await getPool().end()
  }
})
