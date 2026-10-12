import type { CommercialRole } from './types.js'

export type Permission =
  | 'organization.manage'
  | 'member.manage'
  | 'billing.read'
  | 'billing.manage'
  | 'invoice.read'
  | 'account.read'

const rolePermissions: Record<CommercialRole, Permission[]> = {
  owner: ['organization.manage', 'member.manage', 'billing.read', 'billing.manage', 'invoice.read', 'account.read'],
  admin: ['member.manage', 'billing.read', 'billing.manage', 'invoice.read', 'account.read'],
  lawyer: ['billing.read', 'billing.manage', 'invoice.read', 'account.read'],
  reviewer: ['billing.read', 'account.read'],
  assistant: ['billing.read', 'account.read'],
  viewer: ['account.read'],
}

export function hasPermission(role: CommercialRole, permission: Permission) {
  return rolePermissions[role].includes(permission)
}
