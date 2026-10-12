import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { config } from '../config.js'
import type { BillingOrder } from '../types.js'
import type { CommercialRole } from '../commercial/types.js'
import type { PointActionType, PointLedgerEntryType } from '../types.js'

type DevStoreUser = {
  id: string
  email: string
  passwordHash: string
  name: string
  currentSessionId?: string | null
  status: 'active'
}

type DevStoreOrganization = {
  id: string
  name: string
  slug: string
  status: 'active'
}

type DevStoreMembership = {
  id: string
  organizationId: string
  userId: string
  role: CommercialRole
  title: string | null
  status: 'active'
  createdAt: string
}

type DevStorePointAccount = {
  organizationId: string
  userId: string
  balancePoints: number
}

type DevStorePointLedgerEntry = {
  id: string
  organizationId: string
  userId: string
  orderId?: string
  entryType: PointLedgerEntryType
  actionType?: PointActionType
  operationKey?: string
  relatedEntryId?: string
  changePoints: number
  note: string
  metadata?: Record<string, unknown>
  createdAt: string
}

type DevStoreOrder = BillingOrder & {
  organizationId: string
  userId: string
}

type DevStoreInvoiceRequest = {
  id: string
  organizationId: string
  userId: string
  orderId: string
  title: string
  taxNo: string
  registeredAddress: string
  registeredPhone: string
  bankName: string
  bankAccount: string
  recipientEmail?: string
  amountLabel: string
  status: 'draft' | 'submitted' | 'issued'
  createdAt: string
}

type DevStoreUserFeedback = {
  id: string
  organizationId: string
  userId: string
  membershipId?: string
  userEmail: string
  userName: string
  source: 'desktop_app'
  feedbackType: 'bug' | 'suggestion' | 'experience' | 'other'
  title: string
  content: string
  contact?: string
  appVersion?: string
  clientPlatform?: string
  pageContext?: string
  caseName?: string
  status: 'pending' | 'reviewing' | 'resolved' | 'ignored'
  adminNote?: string
  createdAt: string
  updatedAt: string
  handledAt?: string
  handledByEmail?: string
}

export type DevStoreShape = {
  users: DevStoreUser[]
  organizations: DevStoreOrganization[]
  memberships: DevStoreMembership[]
  pointAccounts: DevStorePointAccount[]
  pointLedgerEntries: DevStorePointLedgerEntry[]
  paymentOrders: DevStoreOrder[]
  invoiceRequests: DevStoreInvoiceRequest[]
  userFeedbacks: DevStoreUserFeedback[]
}

const DEFAULT_STORE: DevStoreShape = {
  users: [],
  organizations: [],
  memberships: [],
  pointAccounts: [],
  pointLedgerEntries: [],
  paymentOrders: [],
  invoiceRequests: [],
  userFeedbacks: [],
}

function getStorePath() {
  return path.join(config.cloudServerRoot, '.data', 'dev-store.json')
}

export async function readDevStore(): Promise<DevStoreShape> {
  const storePath = getStorePath()
  try {
    const content = await readFile(storePath, 'utf8')
    return {
      ...DEFAULT_STORE,
      ...(JSON.parse(content) as Partial<DevStoreShape>),
    }
  } catch {
    return { ...DEFAULT_STORE }
  }
}

export async function writeDevStore(store: DevStoreShape) {
  const storePath = getStorePath()
  await mkdir(path.dirname(storePath), { recursive: true })
  await writeFile(storePath, JSON.stringify(store, null, 2), 'utf8')
}

export async function updateDevStore<T>(updater: (store: DevStoreShape) => T | Promise<T>) {
  const store = await readDevStore()
  const result = await updater(store)
  await writeDevStore(store)
  return result
}
