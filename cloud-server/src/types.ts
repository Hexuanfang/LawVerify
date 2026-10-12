export type PaymentChannel = 'alipay' | 'wechat'
export type PaymentOrderStatus = 'pending' | 'paid' | 'closed' | 'failed'
export type PointLedgerEntryType = 'recharge' | 'consume' | 'refund' | 'adjust' | 'freeze' | 'unfreeze'
export type PointActionType =
  | 'document_parse'
  | 'evidence_summary'
  | 'legal_check'
  | 'case_reference'
  | 'evidence_match'
  | 'crosscheck_paragraph'
  | 'crosscheck_full'
  | 'pleading_full'

export interface SitePlan {
  id: string
  name: string
  priceLabel: string
  billingCycle: string
  description: string
  highlights: string[]
  points: number
  recommended?: boolean
}

export interface ReleaseItem {
  id: string
  version: string
  channel: string
  sizeLabel: string
  publishedAt: string
  sha256: string
  notes: string[]
  downloadUrl: string
}

export interface AccountSummary {
  id: string
  displayName: string
  email: string
  tierName: string
  pointsBalance: number
  subscriptionExpiresAt: string
}

export interface UsageMetric {
  label: string
  value: string
}

export interface PointLedgerEntry {
  id: string
  createdAt: string
  description: string
  delta: number
  balanceAfter: number
  entryType?: PointLedgerEntryType
  actionType?: PointActionType
  operationKey?: string
}

export interface PointPolicy {
  actionType: PointActionType
  label: string
  description: string
  unitLabel: string
  pointsPerUnit: number
}

export interface InvoiceProfile {
  id: string
  title: string
  taxNo: string
  type: 'personal' | 'enterprise'
  isDefault: boolean
}

export interface InvoiceRequest {
  id: string
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
}

export interface BillingPackage {
  id: string
  name: string
  amountFen: number
  points: number
  description: string
}

export interface BillingProvider {
  id: PaymentChannel
  label: string
  enabled: boolean
  reason?: string
}

export interface BillingOrder {
  id: string
  orderNo: string
  packageId: string
  packageName: string
  amountFen: number
  points: number
  channel: PaymentChannel
  status: PaymentOrderStatus
  qrCodeContent: string
  paymentUrl?: string
  providerOrderId?: string
  providerMessage?: string
  pointLogId?: string
  createdAt: string
  updatedAt?: string
  expiresAt?: string
  paidAt?: string
}
