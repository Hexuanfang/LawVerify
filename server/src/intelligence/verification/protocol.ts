export type DocKey = 'qs' | 'db' | 'zj' | 'zz' | 'dlc' | 'ss' | 'zs' | 'lsh' | 'flyj' | 'proc'
export type ElementType = 'E-SUBJ' | 'E-CLAIM' | 'E-FACT' | 'E-CALC' | 'E-EVID' | 'E-PURP' | 'E-LAW' | 'E-CASE' | 'E-FOCUS' | 'E-PROC' | 'E-CROSS' | 'E-ERR'
export type CheckCode = `A${1 | 2 | 3 | 4 | 5}` | `B${1 | 2 | 3 | 4 | 5 | 6}` | `C${1 | 2 | 3 | 4 | 5 | 6 | 7}`
export type VerificationVerdict = 'pass' | 'note' | 'warn' | 'miss' | 'fail' | 'pending'
export type CheckOutcome = Exclude<VerificationVerdict, 'note'> | 'not-applicable'
export type FactKind = 'subject' | 'act' | 'time' | 'place' | 'object' | 'result' | 'cause' | 'intent' | 'procedure'
export type EvidenceCell = { row: number; column: number; role: 'header' | 'evidence' | 'purpose' | 'other' }

export interface DeclarationLocation {
  paragraphId: string
  paragraphIndex: number
  sentenceIndex?: number
  start: number
  end: number
  row?: number
  column?: number
}

export interface DeclarationSource {
  tier: 'l1' | 'l2' | 'l3'
  id: string
  name: string
  locator?: string
  quote?: string
  url?: string
  version?: string
}

export interface DocumentDiagnostic {
  code: 'A3'
  verdict: 'warn'
  reason: string
  sources: DeclarationSource[]
}

export type VerificationCalculation =
  | { kind?: 'simple-interest'; principal: number; rate: number; days: number; annualDays: number; amount: number; sources?: DeclarationSource[] }
  | { kind: 'trade-balance'; total: number; paid: number; amount: number; sources: DeclarationSource[] }

export type StatuteValidity = 'VALID' | 'AMENDED' | 'PARTIAL' | 'REPEALED' | 'EXPIRED' | 'PENDING' | 'UNCERTAIN'

export interface StatuteVerificationTrack {
  outcome: string
  checkedAt: string
  url?: string
  version?: string
  validity?: StatuteValidity
  publishDate?: string
  effectiveDate?: string
  repealDate?: string
  issuer?: string
  region?: string
  transitionNote?: string
}

export interface StatuteVerification {
  validity: StatuteValidity
  applicability: 'applicable' | 'inapplicable' | 'uncertain'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  factDate?: string
  checkedAt: string
  provider?: StatuteVerificationTrack
  official?: StatuteVerificationTrack
}

export interface CaseVerification {
  caseNumber: string
  provider: string
  queryOutcome: string
  detailOutcome: string
  checkedAt: string
  allowCitation: boolean
  name?: string
  court?: string
  judgmentDate?: string
  level?: 'guiding' | 'gazette' | 'high-court-reference' | 'ordinary'
  sourceLevel?: string
  effect?: 'effective' | 'pending' | 'vacated' | 'amended' | 'unknown'
  score?: number
  match?: 'strict' | 'analogous' | 'irrelevant'
  dimensions?: Array<{ field: string; score?: number; reason: string }>
  citationKind?: 'operative' | 'reasoning' | 'summary' | 'secondary'
  referencedStatutes?: string[]
  relatedCases?: Array<{ caseNumber: string; relation: 'prior' | 'appeal' | 'retrial'; correction?: 'vacated' | 'amended' }>
  groupId?: string
  counted?: boolean
  documents?: Array<{ id: string; caseNumber: string; provider: string; url: string }>
}

export interface Declaration {
  id: string
  type: ElementType
  quote: string
  location: DeclarationLocation
  factKinds?: FactKind[]
  verdict: VerificationVerdict
  checks: Partial<Record<CheckCode, { outcome: CheckOutcome; reason: string }>>
  sources: DeclarationSource[]
  reason: string
  conf: number | null
  confidenceCalibration?: {
    version: string
    basis: string
    calibrationCases: number
    validationCases: number
    validationAgreementPercent: number
  }
  aiOrigin?: 'draft' | 'rewrite' | 'citation'
  dependencies?: Array<{ id: string; check: CheckCode }>
  differences?: Array<{ field: string; document: string; source: string }>
  statuteVerification?: StatuteVerification
  caseVerification?: CaseVerification
  verifiedText?: string
  verifiedSources?: DeclarationSource[]
  calculation?: VerificationCalculation
  review?: DeclarationReview
}

export interface DeclarationReview {
  revision: string
  decision?: 'confirmed' | 'rejected'
  note?: string
  ignored?: boolean
}

export type DeclarationReviewAction = {
  id: string
  declarationId: string
  revision: string | null
  reviewRevision: string | null
  type: 'confirm' | 'reject' | 'note' | 'ignore' | 'restore-warning' | 'decline'
  checks?: CheckCode[]
  note?: string
}

export type DeclarationEditAction = Pick<DeclarationReviewAction, 'id' | 'declarationId' | 'revision' | 'reviewRevision'> & { type: 'adopt' | 'delete' }
export type DeclarationReferenceEdit = Pick<DeclarationReviewAction, 'id' | 'declarationId' | 'revision' | 'reviewRevision'> & { sourceIds: string[] }

export interface VerificationAudit {
  id: string
  at: string
  actor: string
  action: DeclarationReviewAction['type'] | 'verify' | 'edit' | 'source' | 'adopt' | 'delete'
  paragraphId?: string
  declarationId?: string
  quote?: string
  note?: string
  affected?: string[]
  checks?: CheckCode[]
  previousVerdict?: VerificationVerdict
  sources?: DeclarationSource[]
}

export interface VerificationResult {
  version: 1
  profileVersion: string
  inputKey: string
  docKey?: DocKey
  classificationRequired: boolean
  declarations: Declaration[]
  documentDiagnostics?: DocumentDiagnostic[]
  revision?: string
  authorityKey?: string
  materialVersion?: string
  verifiedAt?: string
  dirty?: { paragraphIds: string[]; declarationIds: string[] }
  manualReferences?: Record<string, string>
  audit?: VerificationAudit[]
}
