import { query } from '../infrastructure/postgres.js';
export async function recordAuditEvent(input) {
    await query(`
      INSERT INTO audit_logs (
        organization_id,
        actor_user_id,
        actor_membership_id,
        action,
        entity_type,
        entity_id,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `, [
        input.organizationId ?? input.actor?.organizationId ?? null,
        input.actor?.userId ?? null,
        input.actor?.membershipId ?? null,
        input.action,
        input.entityType,
        input.entityId ?? null,
        JSON.stringify(input.metadata ?? {}),
    ]);
}
export async function listAuditLogs(organizationId, limit = 50) {
    const result = await query(`
      SELECT id, action, entity_type, entity_id, metadata, created_at
      FROM audit_logs
      WHERE organization_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [organizationId, limit]);
    return result.rows;
}
