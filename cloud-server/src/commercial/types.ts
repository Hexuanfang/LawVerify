export type CommercialRole = 'owner' | 'admin' | 'lawyer' | 'reviewer' | 'assistant' | 'viewer'

export interface AuthClaims {
  sub: string
  organizationId: string
  membershipId: string
  role: CommercialRole
  email: string
  sessionId: string
}

export interface AuthenticatedActor {
  userId: string
  organizationId: string
  membershipId: string
  role: CommercialRole
  email: string
  sessionId: string
}

export interface RegisterAccountInput {
  organizationName: string
  /** 负责人姓名已从注册表单移除；旧客户端仍会传入，非空时照旧保存，否则存空串。 */
  ownerName?: string
  email: string
  password: string
  inviteCode?: string
}

export interface LoginAccountInput {
  email: string
  password: string
}
