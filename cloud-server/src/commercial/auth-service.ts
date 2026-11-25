import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { SignOptions } from 'jsonwebtoken'
import type { PoolClient } from 'pg'

import { config } from '../config.js'
import { AppError } from '../core/app-error.js'
import { readDevStore, updateDevStore, type DevStoreShape } from '../infrastructure/dev-store.js'
import { isDatabaseEnabled, query, getPool, withTransaction } from '../infrastructure/postgres.js'
import { recordAuditEvent } from './audit-service.js'
import type { AuthClaims, AuthenticatedActor, LoginAccountInput, RegisterAccountInput } from './types.js'
import { bindDevReferral, bindStoredReferral } from '../referral-service.js'
import { createPhoneAccountIdentifier, findStoredLoginAccount, isPhoneAccountIdentifier } from './account-identity.js'

const SIGNUP_BONUS_POINTS = 300

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function createSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)

  return slug || `org-${Date.now()}`
}

function signToken(claims: AuthClaims) {
  const options: SignOptions = {
    expiresIn: config.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  }

  return jwt.sign(claims, config.JWT_SECRET, options)
}

function ensurePasswordHash(passwordHash: string | null | undefined) {
  if (typeof passwordHash === 'string' && passwordHash.trim()) {
    return passwordHash
  }

  throw new AppError('当前账号尚未完成密码初始化，请联系管理员处理。', 409, 'PASSWORD_NOT_SET')
}

export function verifyToken(token: string) {
  return jwt.verify(token, config.JWT_SECRET) as AuthClaims
}

function sessionExpiry(token: string) {
  const decoded = jwt.decode(token) as { exp: number }
  return new Date(decoded.exp * 1000).toISOString()
}

async function persistSession(userId: string, sessionId: string, token: string, expectedHash: string | null, phone?: string, client?: PoolClient) {
  const expiresAt = sessionExpiry(token)
  if (!isDatabaseEnabled()) {
    await updateDevStore(store => {
      const user = store.users.find(item => item.id === userId)
      if (!user) throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
      if (user.passwordHash !== expectedHash) throw new AppError('密码已变更，请重新登录。', 401, 'INVALID_CREDENTIALS')
      const legacyId = user.currentSessionId
      user.sessions ??= legacyId ? [{ id: legacyId, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }] : []
      user.sessions = user.sessions.filter(item => !item.revokedAt && Date.parse(item.expiresAt) > Date.now())
      user.sessions.push({ id: sessionId, expiresAt })
      user.currentSessionId = null
    })
    return
  }
  // 校验密码后若遇到并发改密，旧密码不能签发新的登录会话。
  const inserted = await (client ?? getPool()).query(`INSERT INTO account_sessions (id, user_id, expires_at)
    SELECT $1, u.id, $3 FROM users u WHERE u.id = $2 AND u.status = 'active'
      AND CASE WHEN $5::text IS NULL THEN u.password_hash = $4 ELSE u.verified_phone = $5 END
    FOR UPDATE OF u`, [sessionId, userId, expiresAt, expectedHash, phone ?? null])
  if (!inserted.rowCount) throw new AppError('登录凭据已变更，请重新登录。', 401, 'INVALID_CREDENTIALS')
}

type PhoneRegistration = Omit<RegisterAccountInput, 'email' | 'password'> & { phone: string; client: PoolClient }

export async function registerAccount(input: RegisterAccountInput | PhoneRegistration) {
  const phone = 'phone' in input ? input.phone : null
  const phoneUserId = 'phone' in input ? randomUUID() : null
  const email = 'email' in input ? normalizeEmail(input.email) : createPhoneAccountIdentifier(phoneUserId!)
  if (!phone && isPhoneAccountIdentifier(email)) throw new AppError('请输入有效的注册邮箱。', 400, 'INVALID_EMAIL')
  const sessionId = randomUUID()
  // 负责人姓名已从注册表单移除，旧客户端仍可能带上；没带就存空串。
  const ownerName = input.ownerName?.trim() ?? ''

  if (!isDatabaseEnabled()) {
    if ('phone' in input) throw new AppError('当前环境未启用手机号认证。', 503, 'SMS_AUTH_UNAVAILABLE')
    return updateDevStore(async (store) => {
      const existing = store.users.find((item) => item.email === email)
      if (existing) {
        throw new AppError('该邮箱已注册。', 409, 'EMAIL_ALREADY_EXISTS')
      }

      const organizationId = randomUUID()
      const userId = randomUUID()
      const membershipId = randomUUID()
      const passwordHash = await bcrypt.hash(input.password, 10)

      store.organizations.push({
        id: organizationId,
        name: input.organizationName.trim(),
        slug: createSlug(input.organizationName),
        status: 'active',
      })
      store.users.push({
        id: userId,
        email,
        passwordHash,
        name: ownerName,
        currentSessionId: sessionId,
        status: 'active',
      })
      store.memberships.push({
        id: membershipId,
        organizationId,
        userId,
        role: 'owner',
        title: '负责人',
        status: 'active',
        createdAt: new Date().toISOString(),
      })
      store.pointAccounts.push({
        organizationId,
        userId,
        balancePoints: SIGNUP_BONUS_POINTS,
      })
      store.pointLedgerEntries.unshift({
        id: `point-${randomUUID()}`,
        organizationId,
        userId,
        entryType: 'adjust',
        operationKey: `signup-bonus:${userId}`,
        changePoints: SIGNUP_BONUS_POINTS,
        note: `新用户注册赠送 ${SIGNUP_BONUS_POINTS} 积分`,
        metadata: { source: 'signup_bonus' },
        createdAt: new Date().toISOString(),
      })

      bindDevReferral(store, userId, organizationId, input.inviteCode)
      const token = signToken({
        sub: userId,
        organizationId,
        membershipId,
        role: 'owner',
        email,
        sessionId,
      })

      return {
        token,
        user: {
          id: userId,
          email,
          name: ownerName,
        },
        organization: {
          id: organizationId,
          name: input.organizationName.trim(),
          role: 'owner',
        },
      }
    })
  }

  const storeRegistration = async (client: PoolClient) => {
  const existing = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1 LIMIT 1', [email])

  if (existing.rowCount) {
    throw new AppError('该邮箱已注册。', 409, 'EMAIL_ALREADY_EXISTS')
  }

  const passwordHash = 'password' in input ? await bcrypt.hash(input.password, 10) : null

  const organization = await client.query<{ id: string; name: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name',
    [input.organizationName.trim(), createSlug(input.organizationName)],
  )

  const userResult = await client.query<{ id: string; email: string; name: string }>(
    `
      INSERT INTO users (id, email, password_hash, name, status, verified_phone)
      VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, 'active', $5)
      RETURNING id, email, name
    `,
    [phoneUserId, email, passwordHash, ownerName, phone],
  )
  const user = userResult.rows[0]

  const membership = await client.query<{ id: string; role: AuthClaims['role'] }>(
    `
      INSERT INTO organization_memberships (organization_id, user_id, role, title, status)
      VALUES ($1, $2, 'owner', '负责人', 'active')
      RETURNING id, role
    `,
    [organization.rows[0].id, user.id],
  )

  await client.query(
    `
      INSERT INTO point_accounts (organization_id, user_id, balance_points)
      VALUES ($1, $2, $3)
      ON CONFLICT (organization_id, user_id) DO NOTHING
    `,
    [organization.rows[0].id, user.id, SIGNUP_BONUS_POINTS],
  )

  await client.query(
    `
      INSERT INTO point_ledger_entries (
        organization_id,
        commercial_user_id,
        workspace_user_id,
        workspace_user_email,
        workspace_user_name,
        entry_type,
        operation_key,
        change_points,
        note,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, 'adjust', $6, $7, $8, $9::jsonb)
      ON CONFLICT (operation_key) WHERE operation_key IS NOT NULL DO NOTHING
    `,
    [
      organization.rows[0].id,
      user.id,
      user.id,
      user.email,
      user.name,
      `signup-bonus:${user.id}`,
      SIGNUP_BONUS_POINTS,
      `新用户注册赠送 ${SIGNUP_BONUS_POINTS} 积分`,
      JSON.stringify({ source: 'signup_bonus' }),
    ],
  )

  await bindStoredReferral(client, user.id, organization.rows[0].id, input.inviteCode)

  const token = signToken({
    sub: user.id,
    organizationId: organization.rows[0].id,
    membershipId: membership.rows[0].id,
    role: membership.rows[0].role,
    email: user.email,
    sessionId,
  })

  const decoded = jwt.decode(token) as { exp: number }
  await client.query('INSERT INTO account_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
    [sessionId, user.id, new Date(decoded.exp * 1000).toISOString()])
  await client.query(`INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, metadata)
    VALUES ($1, 'auth.register', 'user', $2, $3::jsonb)`,
    [organization.rows[0].id, user.id, JSON.stringify({ email, organizationName: input.organizationName.trim() })])
  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    organization: {
      id: organization.rows[0].id,
      name: organization.rows[0].name,
      role: membership.rows[0].role,
    },
  }
  }
  try {
    return await ('phone' in input ? storeRegistration(input.client) : withTransaction(storeRegistration))
  } catch (error) {
    if (phone && typeof error === 'object' && error && 'constraint' in error && error.constraint === 'idx_users_verified_phone') {
      throw new AppError('该手机号已注册，请直接登录。', 409, 'PHONE_ALREADY_EXISTS')
    }
    throw error
  }
}

const ADMIN_ORG_NAME = 'LawVerify 运营中心'
const ADMIN_DISPLAY_NAME = '超级管理员'

type AdminAccountInput = {
  email: string
  password: string
  name?: string
}

export type AdminAccountStatus = {
  email: string
  exists: boolean
  status?: string
  name?: string
}

// Creates a platform operator account. Existing accounts are never modified here,
// so a restart cannot silently reset a password that was changed on the server.
export async function createAdminAccount(input: AdminAccountInput) {
  const email = normalizeEmail(input.email)
  if (isPhoneAccountIdentifier(email)) throw new AppError('该标识保留给手机号账号。', 400, 'INVALID_EMAIL')
  const name = input.name?.trim() || ADMIN_DISPLAY_NAME
  const passwordHash = await bcrypt.hash(input.password, 10)

  if (!isDatabaseEnabled()) {
    return updateDevStore(async (store) => {
      if (store.users.some(u => u.email === email)) {
        throw new AppError('该账号已存在。', 409, 'ACCOUNT_EXISTS')
      }

      const organizationId = randomUUID()
      const userId = randomUUID()

      store.organizations.push({ id: organizationId, name: ADMIN_ORG_NAME, slug: createSlug(`admin-${email}`), status: 'active' })
      store.users.push({ id: userId, email, passwordHash, name, status: 'active' })
      store.memberships.push({ id: randomUUID(), organizationId, userId, role: 'owner', title: '管理员', status: 'active', createdAt: new Date().toISOString() })
      store.pointAccounts.push({ organizationId, userId, balancePoints: 999999 })
      return { email }
    })
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email])
    if (existing.rowCount) {
      throw new AppError('该账号已存在。', 409, 'ACCOUNT_EXISTS')
    }

    const orgRes = await client.query('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id', [ADMIN_ORG_NAME, createSlug(`admin-${email}-${Date.now()}`)])
    const orgId = orgRes.rows[0].id
    const userRes = await client.query('INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id', [email, passwordHash, name])
    const userId = userRes.rows[0].id
    await client.query('INSERT INTO organization_memberships (organization_id, user_id, role, title) VALUES ($1, $2, $3, $4)', [orgId, userId, 'owner', '管理员'])
    await client.query('INSERT INTO point_accounts (organization_id, user_id, balance_points) VALUES ($1, $2, $3)', [orgId, userId, 999999])
    await client.query('COMMIT')
    return { email }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// Changing a password signs the account out everywhere.
export async function setAccountPassword(emailInput: string, password: string) {
  const email = normalizeEmail(emailInput)
  if (isPhoneAccountIdentifier(email)) throw new AppError('手机号账号使用验证码登录。', 400, 'PHONE_ACCOUNT_ONLY')
  const passwordHash = await bcrypt.hash(password, 10)

  if (!isDatabaseEnabled()) {
    return updateDevStore(async (store) => {
      const user = store.users.find(u => u.email === email)
      if (!user) throw new AppError('账号不存在。', 404, 'ACCOUNT_NOT_FOUND')
      user.passwordHash = passwordHash
      user.currentSessionId = null
      const now = new Date().toISOString()
      for (const session of user.sessions ?? []) session.revokedAt ??= now
      return { email }
    })
  }

  const updated = await query<{ id: string }>('UPDATE users SET password_hash = $1, current_session_id = NULL WHERE email = $2 RETURNING id', [passwordHash, email])
  if (!updated.rowCount) throw new AppError('账号不存在。', 404, 'ACCOUNT_NOT_FOUND')
  await query('UPDATE account_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [updated.rows[0].id])
  return { email }
}

export async function setAccountEmail(currentEmailInput: string, nextEmailInput: string) {
  const currentEmail = normalizeEmail(currentEmailInput)
  const nextEmail = normalizeEmail(nextEmailInput)
  if ([currentEmail, nextEmail].some(isPhoneAccountIdentifier)) throw new AppError('手机号账号使用验证码登录。', 400, 'PHONE_ACCOUNT_ONLY')

  if (!isDatabaseEnabled()) {
    return updateDevStore(async (store) => {
      const user = store.users.find(u => u.email === currentEmail)
      if (!user) throw new AppError('账号不存在。', 404, 'ACCOUNT_NOT_FOUND')
      if (store.users.some(u => u.email === nextEmail)) throw new AppError('新账号名已被使用。', 409, 'ACCOUNT_EXISTS')
      user.email = nextEmail
      user.currentSessionId = null
      const now = new Date().toISOString()
      for (const session of user.sessions ?? []) session.revokedAt ??= now
      return { email: nextEmail }
    })
  }

  const conflict = await query('SELECT id FROM users WHERE email = $1', [nextEmail])
  if (conflict.rowCount) throw new AppError('新账号名已被使用。', 409, 'ACCOUNT_EXISTS')
  const updated = await query<{ id: string }>('UPDATE users SET email = $1, current_session_id = NULL WHERE email = $2 RETURNING id', [nextEmail, currentEmail])
  if (!updated.rowCount) throw new AppError('账号不存在。', 404, 'ACCOUNT_NOT_FOUND')
  await query('UPDATE account_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [updated.rows[0].id])
  return { email: nextEmail }
}

export async function getAccountStatuses(emails: string[]): Promise<AdminAccountStatus[]> {
  const normalized = emails.map(normalizeEmail)

  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    return normalized.map((email) => {
      const user = store.users.find(u => u.email === email)
      return user ? { email, exists: true, status: user.status, name: user.name } : { email, exists: false }
    })
  }

  const result = await query<{ email: string, status: string, name: string }>('SELECT email, status, name FROM users WHERE email = ANY($1)', [normalized])
  return normalized.map((email) => {
    const user = result.rows.find(row => row.email === email)
    return user ? { email, exists: true, status: user.status, name: user.name } : { email, exists: false }
  })
}

// Seeds the first operator account only when it does not exist yet. Credentials come
// from ADMIN_INITIAL_EMAIL / ADMIN_INITIAL_PASSWORD; afterwards use `npm run admin`.
export async function seedAdminAccount() {
  const email = config.ADMIN_INITIAL_EMAIL
  const [status] = await getAccountStatuses([email])
  if (status.exists) return

  const password = config.ADMIN_INITIAL_PASSWORD || (isDatabaseEnabled() ? '' : 'admin@123')
  if (!password) {
    console.warn(`Admin account "${email}" does not exist. Create it with: node dist/scripts/admin-account.js create ${email}`)
    return
  }

  await createAdminAccount({ email, password })
  console.log(`Admin account "${email}" created.`)
}

export async function loginAccount(input: LoginAccountInput) {
  const email = normalizeEmail(input.email)
  if (isPhoneAccountIdentifier(email)) throw new AppError('邮箱或密码错误。', 401, 'INVALID_CREDENTIALS')
  const sessionId = randomUUID()

  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const user = store.users.find((item) => item.email === email && item.status === 'active')
    if (!user) {
      throw new AppError('邮箱或密码错误。', 401, 'INVALID_CREDENTIALS')
    }

    const membership = store.memberships.find((item) => item.userId === user.id && item.status === 'active')
    if (!membership) {
      throw new AppError('邮箱或密码错误。', 401, 'INVALID_CREDENTIALS')
    }

    const passwordHash = ensurePasswordHash(user.passwordHash)
    const passwordMatched = await bcrypt.compare(input.password, passwordHash)
    if (!passwordMatched) {
      throw new AppError('邮箱或密码错误。', 401, 'INVALID_CREDENTIALS')
    }

    const organization = store.organizations.find((item) => item.id === membership.organizationId)
    if (!organization) {
      throw new AppError('当前组织不存在。', 404, 'ORG_NOT_FOUND')
    }

    const token = signToken({
      sub: user.id,
      organizationId: organization.id,
      membershipId: membership.id,
      role: membership.role,
      email: user.email,
      sessionId,
    })

    await persistSession(user.id, sessionId, token, passwordHash)

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      organization: {
        id: organization.id,
        name: organization.name,
        role: membership.role,
      },
    }
  }

  return loginStoredAccount({ email, password: input.password }, sessionId)
}

export async function loginPhoneAccount(phone: string, client: PoolClient) {
  return loginStoredAccount({ phone }, randomUUID(), client)
}

async function loginStoredAccount(input: LoginAccountInput | { phone: string }, sessionId: string, client?: PoolClient) {
  const account = await findStoredLoginAccount(input, client)
  const phone = 'phone' in input ? input.phone : undefined
  if (!account) {
    throw new AppError(phone ? '该手机号尚未注册，请先注册。' : '邮箱或密码错误。', 401, 'INVALID_CREDENTIALS')
  }
  const passwordHash = 'password' in input ? ensurePasswordHash(account.password_hash) : null
  if ('password' in input && !await bcrypt.compare(input.password, passwordHash!)) {
    throw new AppError('邮箱或密码错误。', 401, 'INVALID_CREDENTIALS')
  }

  const token = signToken({
    sub: account.user_id,
    organizationId: account.organization_id,
    membershipId: account.membership_id,
    role: account.role,
    email: account.email,
    sessionId,
  })

  await persistSession(account.user_id, sessionId, token, passwordHash, phone, client)

  await recordAuditEvent({
    organizationId: account.organization_id,
    action: 'auth.login',
    entityType: 'user',
    entityId: account.user_id,
    metadata: { email: account.email },
  }, client)

  return {
    token,
    user: {
      id: account.user_id,
      email: account.email,
      name: account.name,
    },
    organization: {
      id: account.organization_id,
      name: account.organization_name,
      role: account.role,
    },
  }
}

export async function getCurrentActorProfile(claims: AuthClaims | AuthenticatedActor) {
  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const userId = 'sub' in claims ? claims.sub : claims.userId
    const user = store.users.find((item) => item.id === userId && item.status === 'active')
    const membership = store.memberships.find((item) => item.id === claims.membershipId && item.organizationId === claims.organizationId && item.status === 'active')
    const organization = store.organizations.find((item) => item.id === claims.organizationId && item.status === 'active')

    if (!user || !membership || !organization) {
      throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      organization: {
        id: organization.id,
        name: organization.name,
        membershipId: membership.id,
        role: membership.role,
      },
    }
  }

  const result = await query<{
    user_id: string
    user_name: string
    email: string
    verified_phone: string | null
    organization_id: string
    organization_name: string
    membership_id: string
    role: AuthClaims['role']
  }>(
    `
      SELECT
        u.id AS user_id,
        u.name AS user_name,
        u.email,
        u.verified_phone,
        o.id AS organization_id,
        o.name AS organization_name,
        m.id AS membership_id,
        m.role
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.status = 'active'
      JOIN organizations o ON o.id = m.organization_id
      WHERE u.id = $1 AND m.id = $2 AND o.id = $3
      LIMIT 1
    `,
    ['sub' in claims ? claims.sub : claims.userId, claims.membershipId, claims.organizationId],
  )

  if (!result.rowCount) {
    throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
  }

  const profile = result.rows[0]
  return {
    user: {
      id: profile.user_id,
      name: profile.user_name,
      email: profile.email,
      ...(profile.verified_phone ? { maskedPhone: `${profile.verified_phone.slice(0, 3)}****${profile.verified_phone.slice(-4)}` } : {}),
    },
    organization: {
      id: profile.organization_id,
      name: profile.organization_name,
      membershipId: profile.membership_id,
      role: profile.role,
    },
  }
}

function activeDevAccount(store: DevStoreShape, actor: AuthenticatedActor) {
  const user = store.users.find(item => item.id === actor.userId && item.status === 'active')
  const membership = store.memberships.find(item => item.id === actor.membershipId && item.userId === actor.userId
    && item.organizationId === actor.organizationId && item.status === 'active')
  const organization = store.organizations.find(item => item.id === actor.organizationId && item.status === 'active')
  if (!user || !membership || !organization) throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
  const session = user.sessions?.find(item => item.id === actor.sessionId)
  const active = session && !session.revokedAt && Date.parse(session.expiresAt) > Date.now()
  if (!active && !(user.sessions === undefined && user.currentSessionId === actor.sessionId)) {
    throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
  }
  return { user, membership, organization }
}

const accountSettingsQuery = `
  SELECT u.password_hash, m.role FROM users u JOIN account_sessions s ON s.user_id = u.id
  JOIN organization_memberships m ON m.user_id = u.id
  JOIN organizations o ON o.id = m.organization_id
  WHERE u.id = $1 AND m.organization_id = $2 AND m.id = $3 AND s.id = $4
    AND u.status = 'active' AND m.status = 'active' AND o.status = 'active'
    AND s.revoked_at IS NULL AND s.expires_at > NOW()`

export async function updateAccountProfile(actor: AuthenticatedActor, input: { displayName?: string; organizationName?: string }) {
  const checkOrganizationPermission = (role: AuthenticatedActor['role']) => {
    if (input.organizationName !== undefined && role !== 'owner') {
      throw new AppError('仅机构所有者可以修改律所 / 单位名称。', 403, 'FORBIDDEN')
    }
  }
  if (!isDatabaseEnabled()) {
    await updateDevStore(store => {
      const { user, membership, organization } = activeDevAccount(store, actor)
      checkOrganizationPermission(membership.role)
      if (input.displayName !== undefined) user.name = input.displayName
      if (input.organizationName !== undefined) organization.name = input.organizationName
    })
  } else {
    await withTransaction(async client => {
      const result = await client.query<{ role: AuthenticatedActor['role'] }>(accountSettingsQuery + ' FOR UPDATE OF u, s, m, o',
        [actor.userId, actor.organizationId, actor.membershipId, actor.sessionId])
      const membership = result.rows[0]
      if (!membership) throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
      checkOrganizationPermission(membership.role)
      if (input.displayName !== undefined) await client.query('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2',
        [input.displayName, actor.userId])
      if (input.organizationName !== undefined) await client.query('UPDATE organizations SET name = $1, updated_at = NOW() WHERE id = $2',
        [input.organizationName, actor.organizationId])
    })
  }
  return getCurrentActorProfile(actor)
}

export async function changeAccountPassword(actor: AuthenticatedActor, input: { currentPassword: string; newPassword: string }) {
  const hashReplacement = async (storedHash: string | null) => {
    const hash = ensurePasswordHash(storedHash)
    if (!await bcrypt.compare(input.currentPassword, hash)) throw new AppError('当前密码不正确。', 400, 'INCORRECT_PASSWORD')
    if (await bcrypt.compare(input.newPassword, hash)) throw new AppError('新密码不能与当前密码相同。', 400, 'PASSWORD_UNCHANGED')
    return bcrypt.hash(input.newPassword, 10)
  }
  const replacement = (role: AuthenticatedActor['role']) => {
    const id = randomUUID()
    const token = signToken({ sub: actor.userId, email: actor.email, organizationId: actor.organizationId,
      membershipId: actor.membershipId, role, sessionId: id })
    return { token, id, expiresAt: sessionExpiry(token) }
  }
  const assertUnchanged = (current: string | null, previous: string | null) => {
    if (current !== previous) throw new AppError('密码已变更，请重新登录。', 401, 'INVALID_SESSION')
  }
  // 密码哈希计算在锁外执行，写入前重新校验会话及已核验的哈希。
  if (!isDatabaseEnabled()) {
    const previous = activeDevAccount(await readDevStore(), actor).user.passwordHash
    const passwordHash = await hashReplacement(previous)
    return updateDevStore(store => {
      const { user, membership } = activeDevAccount(store, actor)
      assertUnchanged(user.passwordHash, previous)
      const next = replacement(membership.role)
      user.passwordHash = passwordHash
      user.currentSessionId = null
      user.sessions = [{ id: next.id, expiresAt: next.expiresAt }]
      return { token: next.token }
    })
  }
  type PasswordAccount = { password_hash: string | null; role: AuthenticatedActor['role'] }
  const accountIds = [actor.userId, actor.organizationId, actor.membershipId, actor.sessionId]
  const original = (await query<PasswordAccount>(accountSettingsQuery, accountIds)).rows[0]
  if (!original) throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
  const passwordHash = await hashReplacement(original.password_hash)
  return withTransaction(async client => {
    const account = (await client.query<PasswordAccount>(accountSettingsQuery + ' FOR UPDATE OF u, s, m, o', accountIds)).rows[0]
    if (!account) throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
    assertUnchanged(account.password_hash, original.password_hash)
    const next = replacement(account.role)
    await client.query('UPDATE users SET password_hash = $1, current_session_id = NULL, updated_at = NOW() WHERE id = $2',
      [passwordHash, actor.userId])
    await client.query('UPDATE account_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [actor.userId])
    await client.query('INSERT INTO account_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [next.id, actor.userId, next.expiresAt])
    return { token: next.token }
  })
}

export async function assertSessionIsActive(claims: AuthClaims) {
  if (!claims.sessionId?.trim()) {
    throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
  }

  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const user = store.users.find((item) => item.id === claims.sub && item.status === 'active')
    if (!user) {
      throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
    }

    const session = user.sessions?.find(item => item.id === claims.sessionId)
    if (!(session && !session.revokedAt && Date.parse(session.expiresAt) > Date.now())
      && !(user.sessions === undefined && user.currentSessionId === claims.sessionId)) {
      throw new AppError('登录状态已失效，请重新登录。', 401, 'INVALID_SESSION')
    }

    return
  }

  const result = await query(
    `SELECT s.id FROM account_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.user_id = $2 AND u.status = 'active'
       AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [claims.sessionId, claims.sub],
  )

  if (!result.rowCount) {
    throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
  }

}

export async function logoutAccount(claims: AuthClaims | AuthenticatedActor) {
  const userId = 'sub' in claims ? claims.sub : claims.userId

  if (!isDatabaseEnabled()) {
    await updateDevStore(async (store) => {
      const user = store.users.find((item) => item.id === userId && item.status === 'active')
      if (user && user.currentSessionId === claims.sessionId) {
        user.currentSessionId = null
      }
      const session = user?.sessions?.find(item => item.id === claims.sessionId)
      if (session) session.revokedAt = new Date().toISOString()
    })
    return { ok: true }
  }

  await query(
    `
      UPDATE account_sessions
      SET revoked_at = NOW()
      WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL
    `,
    [userId, claims.sessionId],
  )

  return { ok: true }
}
