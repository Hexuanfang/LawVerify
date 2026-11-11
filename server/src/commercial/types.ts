export type CommercialRole = 'owner' | 'admin' | 'lawyer' | 'reviewer' | 'assistant' | 'viewer'

export type StorageProvider = 'local'

export interface AuthClaims {
  sub: string
  organizationId: string
  membershipId: string
  role: CommercialRole
  email: string
}

export interface AuthenticatedActor {
  userId: string
  organizationId: string
  membershipId: string
  role: CommercialRole
  email: string
}

export interface StoredObject {
  key: string
  bucket: string
  originalName: string
  mimeType: string
  size: number
  url: string
  provider: StorageProvider
}

export interface RegisterAccountInput {
  organizationName: string
  /** 负责人姓名已从注册表单移除；旧客户端仍会传入，非空时照旧保存，否则存空串。 */
  ownerName?: string
  email: string
  password: string
}

export interface LoginAccountInput {
  email: string
  password: string
}

export interface CreateMemberInput {
  email: string
  name: string
  role: CommercialRole
  title?: string
}

export interface UploadEvidenceInput {
  caseId?: string
  fileName: string
  mimeType: string
  size: number
  storageKey: string
  storageUrl: string
  provider: StorageProvider
  bucket: string
}
