import { AppError } from '../core/app-error.js';
import { query } from '../infrastructure/postgres.js';
import { recordAuditEvent } from './audit-service.js';
export async function listMembers(actor) {
    const result = await query(`
      SELECT
        m.id AS membership_id,
        u.id AS user_id,
        u.name,
        u.email,
        m.role,
        m.title,
        m.status,
        m.created_at
      FROM organization_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1
      ORDER BY m.created_at ASC
    `, [actor.organizationId]);
    return result.rows;
}
export async function createMember(actor, input) {
    const email = input.email.trim().toLowerCase();
    const existingUser = await query('SELECT id, name FROM users WHERE email = $1 LIMIT 1', [email]);
    let userId = existingUser.rows[0]?.id;
    if (!userId) {
        const createdUser = await query(`
        INSERT INTO users (email, password_hash, name, status)
        VALUES ($1, NULL, $2, 'invited')
        RETURNING id
      `, [email, input.name.trim()]);
        userId = createdUser.rows[0].id;
    }
    const duplicateMembership = await query(`
      SELECT id
      FROM organization_memberships
      WHERE organization_id = $1 AND user_id = $2
      LIMIT 1
    `, [actor.organizationId, userId]);
    if (duplicateMembership.rowCount) {
        throw new AppError('该成员已在当前组织中。', 409, 'MEMBER_ALREADY_EXISTS');
    }
    const membership = await query(`
      INSERT INTO organization_memberships (organization_id, user_id, role, title, status)
      VALUES ($1, $2, $3, $4, 'active')
      RETURNING id, role, title, status
    `, [actor.organizationId, userId, input.role, input.title?.trim() || null]);
    await recordAuditEvent({
        actor,
        action: 'organization.member.create',
        entityType: 'organization_membership',
        entityId: membership.rows[0].id,
        metadata: {
            email,
            role: input.role,
            title: input.title ?? null,
        },
    });
    return {
        membership: {
            id: membership.rows[0].id,
            userId,
            email,
            name: input.name.trim(),
            role: membership.rows[0].role,
            title: membership.rows[0].title,
            status: membership.rows[0].status,
        },
    };
}
