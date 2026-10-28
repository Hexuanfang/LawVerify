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
  ownerName: string
  email: string
  password: string
  inviteCode?: string
}

export interface LoginAccountInput {
  email: string
  password: string
}
