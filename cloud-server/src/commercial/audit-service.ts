import { query } from '../infrastructure/postgres.js'
import type { AuthenticatedActor } from './types.js'

export interface AuditEventInput {
  actor?: AuthenticatedActor
  organizationId?: string
  action: string
  entityType: string
  entityId?: string
  metadata?: Record<string, unknown>
}

export async function recordAuditEvent(input: AuditEventInput) {
  await query(
    `
      INSERT INTO audit_logs (
        organization_id,
        actor_user_id,
        actor_membership_id,
        action,
        entity_type,
        entity_id,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      input.organizationId ?? input.actor?.organizationId ?? null,
      input.actor?.userId ?? null,
      input.actor?.membershipId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  )
}
