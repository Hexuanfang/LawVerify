import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

import { createApp } from '../app.js'
import { registerAccount, verifyToken } from '../commercial/auth-service.js'
import { config } from '../config.js'
import { runMigrations } from '../infrastructure/migrations.js'
import { getPool, query } from '../infrastructure/postgres.js'

const submitPath = '/api/web/cocreate/applications'
const adminPath = '/api/admin/cocreate/applications'
const databaseUrl = process.env.COCREATE_TEST_DATABASE_URL

async function startApp(t: TestContext) {
  const server = createApp().listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return (path: string, body: object, token?: string, method = 'POST') => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

let nextPhone = 13700000000

function application(overrides: Record<string, unknown> = {}) {
  const id = randomUUID()
  return {
    id,
    name: ' 测试律师 ',
    email: `${id}@example.test`,
    phone: String(nextPhone++),
    workYears: '5_to_9',
    region: '浙江省杭州市',
    lawFirm: '示例律师事务所',
    practiceAreas: '民商事诉讼',
    resume: '从事民商事诉讼工作。',
    expectations: '体验证据核验并提供反馈。',
    ...overrides,
  }
}

test('匿名报名接口校验字段，并拒绝客户端指定审核状态或账号', async t => {
  const request = await startApp(t)
  for (const [input, message] of [
    [{ email: undefined }, '请填写邮箱。'],
    [{ email: 'not-an-email' }, '请输入正确的邮箱地址。'],
    [{ phone: undefined }, '请填写手机号。'],
    [{ phone: '12345' }, '请输入有效的中国大陆手机号。'],
  ] as const) {
    const response = await request(submitPath, application(input))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.message, message)
  }
  for (const input of [{ name: '   ' }, { workYears: '10' }, { expectations: '长'.repeat(2001) }, { status: 'approved' }, { userId: randomUUID() }]) {
    const response = await request(submitPath, application(input))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'VALIDATION_ERROR')
  }
  const oldForm = await request(submitPath, application({ email: undefined, phone: undefined, contact: 'wechat_name' }))
  assert.equal(oldForm.status, 400)
  assert.equal((await oldForm.json()).error.code, 'COCREATE_FORM_UPDATED')
  assert.equal((await request(`${adminPath}/search`, {})).status, 401)
  assert.equal((await request(`${adminPath}/${randomUUID()}/approve`, {}, undefined, 'PATCH')).status, 401)
  assert.equal((await request(`${adminPath}/${randomUUID()}/grant-points`, { idempotencyKey: randomUUID() })).status, 401)
})

test('真实数据库写入、注册状态、管理员搜索和并发审核', { skip: !databaseUrl }, async t => {
  assert.ok(databaseUrl)
  const target = new URL(databaseUrl)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), '仅在本地隔离 schema 中运行')
  const control = new Client({ connectionString: databaseUrl })
  await control.connect()
  const schema = `cocreate_test_${randomUUID().replaceAll('-', '')}`
  await control.query(`CREATE SCHEMA "${schema}"`)
  const savedConfig = { database: config.DATABASE_URL, adminEmails: config.ADMIN_EMAILS, migrations: config.MIGRATIONS_DIR }
  target.searchParams.set('options', `-c search_path=${schema}`)
  config.DATABASE_URL = target.toString()
  config.ADMIN_EMAILS = 'cocreate-admin@example.test'
  config.MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))

  t.after(async () => {
    await getPool().end()
    config.DATABASE_URL = savedConfig.database
    config.ADMIN_EMAILS = savedConfig.adminEmails
    config.MIGRATIONS_DIR = savedConfig.migrations
    await control.query(`DROP SCHEMA "${schema}" CASCADE`)
    await control.end()
  })
  await runMigrations()
  const signup = (email: string) => registerAccount({ email, password: randomUUID(), organizationName: '测试机构' })
  const admin = await signup('cocreate-admin@example.test')
  const secondAdmin = await signup('second-admin@example.test')
  config.ADMIN_EMAILS += ',second-admin@example.test'
  const applicant = await signup('lawyer@example.test')
  await query('UPDATE users SET phone = $1 WHERE email = $2', ['+86 138-0013-8000', 'lawyer@example.test'])
  const request = await startApp(t)

  const anonymous = application({ name: ' 未登录律师 ' })
  const associated = application({ name: '登录律师' })
  const phone = application({ name: '手机号报名', phone: '+86 138-0013-8000' })
  const email = application({ name: '邮箱报名', email: ' LAWYER@example.test ' })
  const unmatched = application({ name: '未匹配手机号', phone: '13900139000' })
  const retries = await Promise.all(Array.from({ length: 4 }, () => request(submitPath, anonymous)))
  for (const response of retries) {
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data, { id: anonymous.id })
  }
  assert.equal((await request(submitPath, { ...anonymous, name: '不同报名' })).status, 409)
  await query('ALTER TABLE account_sessions RENAME TO cocreate_unavailable_sessions')
  try {
    const unavailable = await request(submitPath, associated, applicant.token)
    assert.equal(unavailable.status, 503)
    assert.equal((await unavailable.json()).error.code, 'COCREATE_ACCOUNT_UNAVAILABLE')
  } finally {
    await query('ALTER TABLE cocreate_unavailable_sessions RENAME TO account_sessions')
  }
  assert.equal((await request(submitPath, associated, applicant.token)).status, 200)
  assert.equal((await request(submitPath, phone)).status, 200)
  assert.equal((await request(submitPath, email)).status, 200)
  assert.equal((await request(submitPath, unmatched, 'expired-public-session')).status, 200)

  async function assertDuplicate(input: object, code: string, message: string) {
    const response = await request(submitPath, input)
    assert.equal(response.status, 409)
    assert.deepEqual((await response.json()).error, { code, message })
  }
  await assertDuplicate(application({ email: 'lawyer@example.test' }), 'COCREATE_EMAIL_IN_USE', '邮箱已经使用。')
  await assertDuplicate(application({ phone: '13800138000' }), 'COCREATE_PHONE_IN_USE', '手机号已经使用。')
  await assertDuplicate(application({ email: 'Lawyer@example.test', phone: '+86 13800138000' }),
    'COCREATE_CONTACTS_IN_USE', '邮箱和手机号已经使用。')
  assert.equal((await request(`${adminPath}/search`, {}, applicant.token)).status, 403)
  const approvePath = `${adminPath}/${anonymous.id}/approve`
  assert.equal((await request(approvePath, {}, applicant.token, 'PATCH')).status, 403)
  assert.equal((await request(`${adminPath}/${randomUUID()}/approve`, {}, admin.token, 'PATCH')).status, 404)

  const list = async (filters = {}) => {
    const response = await request(`${adminPath}/search`, filters, admin.token)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return (await response.json()).data
  }
  const initial = await list()
  assert.deepEqual(initial.counts, { all: 5, pending: 5, approved: 0 })
  const byId = Object.fromEntries(initial.items.map((item: { id: string }) => [item.id, item]))
  assert.equal(byId[String(anonymous.id)].registered, false)
  assert.equal(byId[String(associated.id)].productAccount, 'lawyer@example.test')
  assert.equal(byId[String(associated.id)].registered, false)
  assert.equal(byId[String(phone.id)].registered, true)
  assert.equal(byId[String(phone.id)].canGrantPoints, false)
  assert.equal(byId[String(phone.id)].phone, '13800138000')
  assert.equal(byId[String(email.id)].registered, true)
  assert.equal(byId[String(email.id)].email, 'lawyer@example.test')
  assert.equal(byId[String(unmatched.id)].registered, false)
  assert.deepEqual((await list({ query: anonymous.email })).items, [{
    ...anonymous, contact: null, name: '未登录律师', status: 'pending', registered: false, productAccount: null,
    pointsGranted: '0', canGrantPoints: false, pointsGrantBlockedReason: '审核通过后可发放积分。', pointsRecipient: null,
    submittedAt: byId[String(anonymous.id)].submittedAt,
  }])
  assert.equal((await list({ query: '13800138000' })).items[0].id, phone.id)

  const approvals = await Promise.all([admin.token, secondAdmin.token].map(token => request(approvePath, {}, token, 'PATCH')))
  for (const response of approvals) assert.equal(response.status, 200)
  const review = await query<{ reviewed_at: Date; reviewed_by_user_id: string }>(
    'SELECT reviewed_at, reviewed_by_user_id FROM cocreate_applications WHERE id = $1', [anonymous.id],
  )
  assert.ok(review.rows[0].reviewed_at)
  assert.ok(review.rows[0].reviewed_by_user_id)
  assert.equal((await request(approvePath, {}, admin.token, 'PATCH')).status, 200)
  const repeated = await query('SELECT reviewed_at, reviewed_by_user_id FROM cocreate_applications WHERE id = $1', [anonymous.id])
  assert.deepEqual(repeated.rows, review.rows)
  const confirmed = await list({ status: 'approved' })
  assert.deepEqual(confirmed.counts, { all: 5, pending: 4, approved: 1 })
  assert.equal(confirmed.items.length, 1)
  assert.equal(confirmed.items[0].id, anonymous.id)
  assert.equal(confirmed.items[0].status, 'approved')

  const applicantUserId = verifyToken(applicant.token).sub
  const award = (applicationId: string, idempotencyKey = randomUUID(), token = admin.token, recipientUserId = applicantUserId) =>
    request(`${adminPath}/${applicationId}/grant-points`, { idempotencyKey, recipientUserId }, token)
  assert.equal((await award(String(phone.id), randomUUID(), applicant.token)).status, 403)
  assert.equal((await award(String(phone.id))).status, 409)
  assert.equal((await award(String(anonymous.id))).status, 409)
  assert.equal((await request(`${adminPath}/${phone.id}/approve`, {}, admin.token, 'PATCH')).status, 200)
  const eligible = (await list({ query: '13800138000' })).items[0]
  assert.equal(eligible.canGrantPoints, true)
  assert.equal(eligible.pointsGranted, '0')
  assert.deepEqual(eligible.pointsRecipient, { userId: applicantUserId, account: 'lawyer@example.test' })

  const wrongRecipient = await award(String(phone.id), randomUUID(), admin.token, verifyToken(secondAdmin.token).sub)
  assert.equal(wrongRecipient.status, 409)
  assert.equal((await wrongRecipient.json()).error.code, 'COCREATE_POINTS_RECIPIENT_CHANGED')

  const balance = async () => (await query<{ balance_points: number }>(`
    SELECT a.balance_points FROM point_accounts a JOIN users u ON a.user_id = u.id
    WHERE u.email = 'lawyer@example.test'
  `)).rows[0].balance_points
  const initialBalance = await balance()
  const firstKey = randomUUID()
  const awards = await Promise.all(Array.from({ length: 4 }, () => award(String(phone.id), firstKey)))
  for (const response of awards) {
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data, {
      pointsGranted: '50000', pointsBalance: initialBalance + 50_000,
      message: `积分已发放，当前积分：${initialBalance + 50_000}`,
    })
  }
  assert.equal(await balance(), initialBalance + 50_000)
  const secondAward = await award(String(phone.id))
  assert.equal(secondAward.status, 200)
  assert.equal((await secondAward.json()).data.pointsGranted, '100000')
  assert.equal(await balance(), initialBalance + 100_000)
  const replay = await award(String(phone.id), firstKey)
  assert.equal((await replay.json()).data.pointsBalance, initialBalance + 100_000)
  const reloaded = (await list({ query: '13800138000' })).items[0]
  assert.equal(reloaded.canGrantPoints, true)
  assert.equal(reloaded.pointsGranted, '100000')
  const ledger = await query<{ count: number; points: number }>(`
    SELECT count(*)::int AS count, sum(change_points)::int AS points
    FROM point_ledger_entries WHERE metadata->>'source' = 'cocreate_reward'
  `)
  assert.deepEqual(ledger.rows, [{ count: 2, points: 100_000 }])

  await query('ALTER TABLE point_ledger_entries ADD CONSTRAINT test_cocreate_ledger_failure CHECK (change_points < 50000) NOT VALID')
  try {
    assert.equal((await award(String(phone.id))).status, 500)
    assert.equal(await balance(), initialBalance + 100_000)
    assert.equal((await list({ query: '13800138000' })).items[0].pointsGranted, '100000')
  } finally {
    await query('ALTER TABLE point_ledger_entries DROP CONSTRAINT test_cocreate_ledger_failure')
  }

  await query('UPDATE users SET phone = $1 WHERE email = $2', ['13400000000', 'second-admin@example.test'])
  const ambiguous = application({ name: '联系信息冲突', email: 'cocreate-admin@example.test', phone: '13400000000' })
  assert.equal((await request(submitPath, ambiguous)).status, 200)
  assert.equal((await request(`${adminPath}/${ambiguous.id}/approve`, {}, admin.token, 'PATCH')).status, 200)
  const accountConflict = (await list({ query: '联系信息冲突' })).items[0]
  assert.equal(accountConflict.registered, true)
  assert.equal(accountConflict.canGrantPoints, false)
  assert.equal((await award(String(ambiguous.id))).status, 409)

  const sameContact = { email: 'parallel@example.test', phone: '13600000000' }
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => request(submitPath, application(sameContact))))
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409, 409, 409])

  for (const contact of ['微信历史账号', '13500000000', '+86 135-0000-0000', ' Legacy@Example.test ']) {
    await query(`INSERT INTO cocreate_applications
      (id, name, contact, work_years, region, law_firm, practice_areas, resume, expectations)
      VALUES ($1, '历史报名', $2, '5_to_9', '北京', '示例律所', '诉讼', '履历', '反馈')`, [randomUUID(), contact])
  }
  const migration = await readFile(new URL('../../migrations/011_cocreate_application_contacts.sql', import.meta.url), 'utf8')
  await query(migration)
  const legacy = (await list({ query: '历史报名' })).items
  assert.equal(legacy.length, 4)
  assert.equal(legacy.filter((item: { phone: string | null }) => item.phone === '13500000000').length, 1)
  assert.equal(legacy.find((item: { contact: string }) => item.contact === '微信历史账号').registered, false)
  assert.ok(legacy.some((item: { phone: string | null; contact: string }) => !item.phone && item.contact === '+86 135-0000-0000'))
  await assertDuplicate(application({ phone: '13500000000' }), 'COCREATE_PHONE_IN_USE', '手机号已经使用。')
  await assertDuplicate(application({ email: 'legacy@example.test' }), 'COCREATE_EMAIL_IN_USE', '邮箱已经使用。')
})
