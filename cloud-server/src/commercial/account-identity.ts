import type { PoolClient } from 'pg'
import { getPool } from '../infrastructure/postgres.js'
import type { AuthClaims } from './types.js'

const phoneDomain = '@phone.lawverify.invalid'

export function createPhoneAccountIdentifier(userId: string) {
  return userId + phoneDomain
}

export function isPhoneAccountIdentifier(value: string) {
  return value.toLowerCase().endsWith(phoneDomain)
}

export async function findStoredLoginAccount(identifier: { email: string } | { phone: string }, client?: PoolClient) {
  const byPhone = 'phone' in identifier
  const result = await (client ?? getPool()).query<{
    user_id: string
    email: string
    name: string
    password_hash: string | null
    organization_id: string
    organization_name: string
    membership_id: string
    role: AuthClaims['role']
  }>(`
      SELECT u.id AS user_id, u.email, u.name, u.password_hash,
        o.id AS organization_id, o.name AS organization_name, m.id AS membership_id, m.role
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.status = 'active'
      JOIN organizations o ON o.id = m.organization_id
      WHERE ${byPhone ? 'u.verified_phone' : 'u.email'} = $1 AND u.status = 'active'
      ORDER BY m.created_at ASC LIMIT 1
    `, [byPhone ? identifier.phone : identifier.email])
  return result.rows[0]
}
