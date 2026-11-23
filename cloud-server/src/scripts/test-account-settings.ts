import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { createApp } from '../app.js'
import { registerAccount } from '../commercial/auth-service.js'
import { config } from '../config.js'
import { updateDevStore } from '../infrastructure/dev-store.js'

test('账号设置允许本人更新资料，并在修改密码时换发令牌', async () => {
  const previous = { root: config.cloudServerRoot, database: config.DATABASE_URL }
  const scratch = path.resolve(previous.root, '..', 'tmp')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(path.join(scratch, 'account-settings-test-'))
  config.cloudServerRoot = directory
  config.DATABASE_URL = undefined
  const server = createApp().listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api/account`
    const request = (route: string, method: 'GET' | 'PUT' | 'POST' = 'GET', body?: object, token?: string) => fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(method !== 'GET' && body ? { body: JSON.stringify(body) } : {}),
    })
    const originalPassword = randomUUID()
    const newPassword = randomUUID()
    const email = 'account-settings@example.test'
    const legacyName = '旧版长名称'.repeat(6)
    const owner = await registerAccount({ email, password: originalPassword, ownerName: legacyName, organizationName: '原律所' })
    const login = async (password: string) => {
      const response = await request('/login', 'POST', { email, password })
      assert.equal(response.status, 200)
      return (await response.json()).data.token as string
    }
    const otherToken = await login(originalPassword)
    const renamed = await request('/profile', 'PUT', { organizationName: '仅修改律所' }, owner.token)
    assert.equal(renamed.status, 200)
    assert.equal((await renamed.json()).data.user.name, legacyName)
    assert.equal((await request('/profile', 'PUT', {}, owner.token)).status, 400)
    const updated = await request('/profile', 'PUT', { displayName: '新名称', organizationName: '新律所' }, owner.token)
    assert.equal(updated.status, 200)
    const updatedProfile = (await updated.json()).data
    assert.equal(updatedProfile.user.name, '新名称')
    assert.equal(updatedProfile.organization.name, '新律所')
    assert.equal((await request('/profile', 'PUT', { displayName: '未授权' })).status, 401)
    await updateDevStore(store => {
      store.memberships.find(member => member.userId === owner.user.id)!.role = 'lawyer'
    })
    assert.equal((await request('/profile', 'PUT', { displayName: '未保存', organizationName: '越权律所' }, owner.token)).status, 403)
    const unchangedProfile = (await (await request('/profile', 'GET', undefined, owner.token)).json()).data
    assert.equal(unchangedProfile.user.name, '新名称')
    assert.equal(unchangedProfile.organization.name, '新律所')
    assert.equal((await request('/profile', 'PUT', { displayName: '新署名' }, owner.token)).status, 200)
    assert.equal((await request('/password', 'PUT', { currentPassword: randomUUID(), newPassword }, owner.token)).status, 400)
    assert.equal((await request('/password', 'PUT', { currentPassword: originalPassword, newPassword: '密'.repeat(25) }, owner.token)).status, 400)
    const rotations = await Promise.all([owner.token, otherToken].map(token =>
      request('/password', 'PUT', { currentPassword: originalPassword, newPassword }, token)))
    const rotation = rotations.find(response => response.status === 200)
    assert.ok(rotation)
    assert.equal(rotations.filter(response => response.status === 200).length, 1)
    const { token } = (await rotation.json()).data
    assert.ok(token && token !== owner.token && token !== otherToken)
    for (const revoked of [owner.token, otherToken]) {
      assert.equal((await request('/profile', 'GET', undefined, revoked)).status, 401)
    }
    const replacement = await request('/profile', 'GET', undefined, token)
    assert.equal(replacement.status, 200)
    assert.equal((await replacement.json()).data.user.name, '新署名')
    assert.equal((await request('/login', 'POST', { email, password: originalPassword })).status, 401)
    assert.ok(await login(newPassword))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    config.cloudServerRoot = previous.root
    config.DATABASE_URL = previous.database
    const data = path.join(directory, '.data')
    await rm(path.join(data, 'dev-store.json'), { force: true })
    await rmdir(data).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
})
