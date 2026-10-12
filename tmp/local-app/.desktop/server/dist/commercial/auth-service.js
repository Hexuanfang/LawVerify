import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../core/app-error.js';
import { query } from '../infrastructure/postgres.js';
import { recordAuditEvent } from './audit-service.js';
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function signToken(claims) {
    const options = {
        expiresIn: env.JWT_EXPIRES_IN,
    };
    return jwt.sign(claims, env.JWT_SECRET, options);
}
export function verifyToken(token) {
    return jwt.verify(token, env.JWT_SECRET);
}
export async function registerAccount(input) {
    const email = normalizeEmail(input.email);
    const existing = await query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
    if (existing.rowCount) {
        throw new AppError('该邮箱已注册。', 409, 'EMAIL_ALREADY_EXISTS');
    }
    const passwordHash = await bcrypt.hash(input.password, 10);
    const organization = await query('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name', [input.organizationName.trim(), createSlug(input.organizationName)]);
    const organizationId = organization.rows[0].id;
    const userResult = await query(`
      INSERT INTO users (email, password_hash, name, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING id, email, name
    `, [email, passwordHash, input.ownerName.trim()]);
    const user = userResult.rows[0];
    const membership = await query(`
      INSERT INTO organization_memberships (organization_id, user_id, role, title, status)
      VALUES ($1, $2, 'owner', '负责人', 'active')
      RETURNING id, role
    `, [organizationId, user.id]);
    await recordAuditEvent({
        organizationId,
        action: 'auth.register',
        entityType: 'user',
        entityId: user.id,
        metadata: { email, organizationName: input.organizationName.trim() },
    });
    const token = signToken({
        sub: user.id,
        organizationId,
        membershipId: membership.rows[0].id,
        role: 'owner',
        email: user.email,
    });
    return {
        token,
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
        },
        organization: {
            id: organizationId,
            name: organization.rows[0].name,
            role: membership.rows[0].role,
        },
    };
}
export async function loginAccount(input) {
    const email = normalizeEmail(input.email);
    const result = await query(`
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
    `, [email]);
    if (!result.rowCount) {
        throw new AppError('账号或密码错误。', 401, 'INVALID_CREDENTIALS');
    }
    const account = result.rows[0];
    const passwordMatched = await bcrypt.compare(input.password, account.password_hash);
    if (!passwordMatched) {
        throw new AppError('账号或密码错误。', 401, 'INVALID_CREDENTIALS');
    }
    const token = signToken({
        sub: account.user_id,
        organizationId: account.organization_id,
        membershipId: account.membership_id,
        role: account.role,
        email: account.email,
    });
    await recordAuditEvent({
        organizationId: account.organization_id,
        action: 'auth.login',
        entityType: 'user',
        entityId: account.user_id,
        metadata: { email: account.email },
    });
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
    };
}
export async function getCurrentActorProfile(claims) {
    const result = await query(`
      SELECT
        u.id AS user_id,
        u.name AS user_name,
        u.email,
        o.id AS organization_id,
        o.name AS organization_name,
        m.id AS membership_id,
        m.role
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id
      JOIN organizations o ON o.id = m.organization_id
      WHERE u.id = $1 AND m.id = $2 AND o.id = $3 AND m.status = 'active'
      LIMIT 1
    `, [claims.sub, claims.membershipId, claims.organizationId]);
    if (!result.rowCount) {
        throw new AppError('当前登录态无效。', 401, 'INVALID_SESSION');
    }
    const profile = result.rows[0];
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
    };
}
function createSlug(value) {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
    return slug || `org-${Date.now()}`;
}
