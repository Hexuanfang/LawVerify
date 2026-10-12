import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { SignOptions } from 'jsonwebtoken'

import { config } from '../config.js'
import { AppError } from '../core/app-error.js'
import { readDevStore, updateDevStore } from '../infrastructure/dev-store.js'
import { isDatabaseEnabled, query, getPool } from '../infrastructure/postgres.js'
import { recordAuditEvent } from './audit-service.js'
import type { AuthClaims, AuthenticatedActor, LoginAccountInput, RegisterAccountInput } from './types.js'

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

function buildSessionReplacedError() {
  return new AppError('当前账号已在另一台设备登录，本设备已下线，请重新登录。', 401, 'SESSION_REPLACED')
}

export async function registerAccount(input: RegisterAccountInput) {
  const email = normalizeEmail(input.email)
  const sessionId = randomUUID()

  if (!isDatabaseEnabled()) {
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
        name: input.ownerName.trim(),
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
          name: input.ownerName.trim(),
        },
        organization: {
          id: organizationId,
          name: input.organizationName.trim(),
          role: 'owner',
        },
      }
    })
  }

  const existing = await query<{ id: string }>('SELECT id FROM users WHERE email = $1 LIMIT 1', [email])

  if (existing.rowCount) {
    throw new AppError('该邮箱已注册。', 409, 'EMAIL_ALREADY_EXISTS')
  }

  const passwordHash = await bcrypt.hash(input.password, 10)

  const organization = await query<{ id: string; name: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name',
    [input.organizationName.trim(), createSlug(input.organizationName)],
  )

  const userResult = await query<{ id: string; email: string; name: string }>(
    `
      INSERT INTO users (email, password_hash, name, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING id, email, name
    `,
    [email, passwordHash, input.ownerName.trim()],
  )
  const user = userResult.rows[0]

  const membership = await query<{ id: string; role: AuthClaims['role'] }>(
    `
      INSERT INTO organization_memberships (organization_id, user_id, role, title, status)
      VALUES ($1, $2, 'owner', '负责人', 'active')
      RETURNING id, role
    `,
    [organization.rows[0].id, user.id],
  )

  await query(
    `
      INSERT INTO point_accounts (organization_id, user_id, balance_points)
      VALUES ($1, $2, $3)
      ON CONFLICT (organization_id, user_id) DO NOTHING
    `,
    [organization.rows[0].id, user.id, SIGNUP_BONUS_POINTS],
  )

  await query(
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

  await recordAuditEvent({
    organizationId: organization.rows[0].id,
    action: 'auth.register',
    entityType: 'user',
    entityId: user.id,
    metadata: { email, organizationName: input.organizationName.trim() },
  })

  const token = signToken({
    sub: user.id,
    organizationId: organization.rows[0].id,
    membershipId: membership.rows[0].id,
    role: membership.rows[0].role,
    email: user.email,
    sessionId,
  })

  await query(
    'UPDATE users SET current_session_id = $1, updated_at = NOW() WHERE id = $2',
    [sessionId, user.id],
  )

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

export async function seedAdminAccount() {
  const email = 'admin'
  const password = 'admin@123'
  const name = '超级管理员'
  const orgName = 'LawVerify 运营中心'
  const passwordHash = await bcrypt.hash(password, 10)

  if (!isDatabaseEnabled()) {
    return updateDevStore(async (store) => {
      const user = store.users.find(u => u.email === email)
      if (user) {
        user.passwordHash = passwordHash
        return
      }

      const organizationId = randomUUID()
      const userId = randomUUID()
      const membershipId = randomUUID()

      store.organizations.push({ id: organizationId, name: orgName, slug: 'admin-org', status: 'active' })
      store.users.push({ id: userId, email, passwordHash, name, status: 'active' })
      store.memberships.push({ id: membershipId, organizationId, userId, role: 'owner', title: '管理员', status: 'active', createdAt: new Date().toISOString() })
      store.pointAccounts.push({ organizationId, userId, balancePoints: 999999 })
    })
  }

  const existing = await query('SELECT id FROM users WHERE email = $1', [email])
  if (existing.rowCount) {
    await query('UPDATE users SET password_hash = $1 WHERE email = $2', [passwordHash, email])
    return
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    
    const orgRes = await client.query('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id', [orgName, 'admin-org'])
    const orgId = orgRes.rows[0].id

    const userRes = await client.query('INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id', [email, passwordHash, name])
    const userId = userRes.rows[0].id

    await client.query('INSERT INTO organization_memberships (organization_id, user_id, role, title) VALUES ($1, $2, $3, $4)', [orgId, userId, 'owner', '管理员'])
    
    await client.query('INSERT INTO point_accounts (organization_id, user_id, balance_points) VALUES ($1, $2, $3)', [orgId, userId, 999999])

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export async function loginAccount(input: LoginAccountInput) {
  const email = normalizeEmail(input.email)
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

    const passwordMatched = await bcrypt.compare(input.password, ensurePasswordHash(user.passwordHash))
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

    await updateDevStore(async (draft) => {
      const currentUser = draft.users.find((item) => item.id === user.id)
      if (currentUser) {
        currentUser.currentSessionId = sessionId
      }
    })

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

  const result = await query<{
    user_id: string
    email: string
    name: string
    password_hash: string | null
    organization_id: string
    organization_name: string
    membership_id: string
    role: AuthClaims['role']
  }>(
    `
      SELECT
        u.id AS user_id,
        u.email,
        u.name,
        u.password_hash,
        o.id AS organization_id,
        o.name AS organization_name,
        m.id AS membership_id,
        m.role
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.status = 'active'
      JOIN organizations o ON o.id = m.organization_id
      WHERE u.email = $1 AND u.status = 'active'
      ORDER BY m.created_at ASC
      LIMIT 1
    `,
    [email],
  )

  if (!result.rowCount) {
    throw new AppError('邮箱或密码错误。', 401, 'INVALID_CREDENTIALS')
  }

  const account = result.rows[0]
  const passwordMatched = await bcrypt.compare(input.password, ensurePasswordHash(account.password_hash))
  if (!passwordMatched) {
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

  await query(
    'UPDATE users SET current_session_id = $1, updated_at = NOW() WHERE id = $2',
    [sessionId, account.user_id],
  )

  await recordAuditEvent({
    organizationId: account.organization_id,
    action: 'auth.login',
    entityType: 'user',
    entityId: account.user_id,
    metadata: { email: account.email },
  })

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
    },
    organization: {
      id: profile.organization_id,
      name: profile.organization_name,
      membershipId: profile.membership_id,
      role: profile.role,
    },
  }
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

    if (!user.currentSessionId) {
      throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
    }

    if (user.currentSessionId !== claims.sessionId) {
      throw buildSessionReplacedError()
    }

    return
  }

  const result = await query<{ current_session_id: string | null }>(
    'SELECT current_session_id FROM users WHERE id = $1 AND status = $2 LIMIT 1',
    [claims.sub, 'active'],
  )

  if (!result.rowCount) {
    throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
  }

  const currentSessionId = result.rows[0].current_session_id
  if (!currentSessionId) {
    throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION')
  }

  if (currentSessionId !== claims.sessionId) {
    throw buildSessionReplacedError()
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
    })
    return { ok: true }
  }

  await query(
    `
      UPDATE users
      SET current_session_id = NULL, updated_at = NOW()
      WHERE id = $1 AND current_session_id = $2
    `,
    [userId, claims.sessionId],
  )

  return { ok: true }
}
