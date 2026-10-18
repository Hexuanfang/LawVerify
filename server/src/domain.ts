export type RoleType = 'plaintiff' | 'defendant'

export type EvidenceType = 'pdf' | 'ppt' | 'image' | 'word' | 'text' | 'other'
export type EvidenceFragmentType = 'document' | 'page' | 'paragraph' | 'ocr_block' | 'image_region' | 'audio_segment'
export type EvidenceFragmentSourceKind = 'native_text' | 'ocr' | 'asr' | 'vision'
export type ClaimUnitStatus = 'unmatched' | 'linked' | 'matched' | 'conflicted' | 'insufficient'
export type ClaimEvidenceRelation = 'support' | 'partial' | 'contradict' | 'unrelated' | 'insufficient'
export type ClaimEvidenceMatchSource = 'manual' | 'heuristic' | 'model'
export type EvidenceInsightStatus = 'idle' | 'processing' | 'ready' | 'failed'

export interface PointLog {
  id: string
  type: 'consume' | 'recharge'
  amount: number
  note: string
  createdAt: string
}

export type PaymentProvider = 'alipay' | 'wechat'
export type RechargeOrderStatus = 'pending' | 'paid' | 'closed' | 'failed'

export interface RechargePackage {
  id: string
  title: string
  description: string
  points: number
  amountFen: number
}

export interface PaymentProviderStatus {
  id: PaymentProvider
  label: string
  enabled: boolean
  reason?: string
}

export interface RechargeOrder {
  id: string
  userId: string
  packageId: string
  channel: PaymentProvider
  title: string
  description: string
  amountFen: number
  points: number
  outTradeNo: string
  status: RechargeOrderStatus
  qrCodeContent?: string
  paymentUrl?: string
  providerOrderId?: string
  providerMessage?: string
  pointLogId?: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  paidAt?: string
}

export interface UserAccount {
  id: string
  name: string
  phone: string
  email: string
  organization: string
  title: string
  points: number
  pointLogs: PointLog[]
}

export interface Evidence {
  id: string
  caseId: string
  number: string
  name: string
  type: EvidenceType
  fileName: string
  relativePath?: string
  uploadedAt: string
  ocrText: string
  previewDataUrl?: string
  sourceDataUrl?: string
  storageKey?: string
  storageUrl?: string
  pageImageDataUrls?: string[]
  sourceMimeType?: string
  pages?: number
  anchorHint?: string
  summaryText?: string
  summaryStatus?: 'idle' | 'processing' | 'ready' | 'failed'
  summaryError?: string
  summaryUpdatedAt?: string
  summaryCacheKey?: string
}

export interface EvidenceFragment {
  id: string
  caseId: string
  evidenceId: string
  fragmentType: EvidenceFragmentType
  sourceKind: EvidenceFragmentSourceKind
  sequence: number
  locator: string
  text: string
  summary: string
  keywords: string[]
  page?: number
  timeStartMs?: number
  timeEndMs?: number
  confidence?: number
}

export interface EvidenceLink {
  id?: string
  evidenceId: string
  locator: string
  quote: string
  sentenceIndex?: number
  sentenceText?: string
  note?: string
  relation?: 'support' | 'contradict' | 'context'
  reason?: string
}

export type ParagraphReferenceType = 'case' | 'statute'

export interface ParagraphReference {
  id?: string
  type: ParagraphReferenceType
  targetId: string
  sourceTitle: string
  label: string
  locator: string
  quote: string
  sentenceIndex?: number
  sentenceText?: string
  note?: string
  reason?: string
}

export interface CertificateParagraph {
  id: string
  text: string
  richText?: string
  note?: string
  verified: boolean
  link?: EvidenceLink
  links?: EvidenceLink[]
  references?: ParagraphReference[]
  linkageFocus?: SentenceLinkageFocus[]
}

export interface SentenceLinkageFocus {
  sentenceIndex: number
  sentenceText: string
  kind: 'fact' | 'dispute' | 'legal_issue' | 'identity' | 'background' | 'heading'
  priority: 'high' | 'normal' | 'skip'
  reason: string
  evidenceNeeded: boolean
  statuteNeeded: boolean
  caseNeeded: boolean
}

export interface ClaimUnit {
  id: string
  caseId: string
  certificateId: string
  paragraphId: string
  sentenceIndex: number
  text: string
  normalizedText: string
  sourceParagraphText: string
  labels: string[]
  status: ClaimUnitStatus
}

export interface ClaimEvidenceMatch {
  id: string
  caseId: string
  claimUnitId: string
  evidenceId: string
  evidenceFragmentId: string
  relation: ClaimEvidenceRelation
  score: number
  reason?: string
  quote?: string
  locator: string
  source: ClaimEvidenceMatchSource
  verified: boolean
}

export interface EvidenceInsight {
  id: string
  caseId: string
  evidenceId: string
  version: number
  summary: string
  keyFacts: string[]
  entities: string[]
  timelineEvents: string[]
  amounts: string[]
  positions: string[]
  issues: string[]
  materialRole?: 'source_evidence' | 'identity' | 'working_draft' | 'party_statement' | 'reference_material' | 'unknown'
  proofPurposes?: string[]
  proofLimitations?: string[]
  disputedPoints?: string[]
  keyExcerpts?: { quote: string; significance: string; pageNumber?: number }[]
  sourceFragmentIds: string[]
  confidence: number
  status: EvidenceInsightStatus
  error?: string
  updatedAt: string
}

export interface CaseContextSupportItem {
  fact: string
  evidenceIds: string[]
  evidenceNumbers: string[]
}

export interface CaseContextMemory {
  id: string
  caseId: string
  version: number
  summary: string
  parties: string[]
  disputeFocuses: string[]
  claimsAndDefenses: string[]
  disputedFacts: string[]
  timeline: string[]
  paymentFlow: string[]
  keyPersons: string[]
  keyAmounts: string[]
  lawyerFocuses: string[]
  evidenceWeaknesses: string[]
  proceduralRisks: string[]
  contradictions: string[]
  openQuestions: string[]
  supportMatrix: CaseContextSupportItem[]
  evidenceInsightIds: string[]
  updatedAt: string
}

export interface DraftMemoryParagraphPlan {
  paragraphId: string
  intent: string
  evidenceNumbers: string[]
}

export interface DraftMemory {
  id: string
  caseId: string
  certificateId: string
  writingGoal: string
  caseContextMemoryId?: string
  usedEvidenceInsightIds: string[]
  paragraphPlans: DraftMemoryParagraphPlan[]
  updatedAt: string
}

export interface Certificate {
  id: string
  caseId: string
  title: string
  role: RoleType
  focus: string
  paragraphIds: string[]
  paragraphs: CertificateParagraph[]
  createdAt: string
}

export interface CaseFolder {
  id: string
  name: string
  description: string
  createdAt: string
  status: 'draft' | 'in_review' | 'ready'
}

export interface KnowledgeCaseExcerpt {
  id: string
  caseId: string
  excerptType: 'holding' | 'reasoning' | 'issue'
  locator: string
  content: string
  summary: string
  keywords: string[]
}

export interface KnowledgeCase {
  id: string
  title: string
  caseNumber: string
  courtName: string
  courtLevel: string
  region: string
  trialLevel: string
  caseType: string
  cause: string
  judgmentDate: string
  effectiveDate: string
  issueSummary: string
  holdingSummary: string
  reasoningSummary: string
  resultSummary: string
  sourceUrl?: string
  sourceType: string
  keywords: string[]
  focusTags: string[]
  referencedStatutes: string[]
  excerpts: KnowledgeCaseExcerpt[]
}

export interface KnowledgeStatuteArticle {
  id: string
  documentId: string
  articleNumber: string
  clauseNumber?: string
  itemNumber?: string
  content: string
  plainText: string
  aliases: string[]
  topicTags: string[]
}

export type LegalSourceProvider = 'npc_flk' | 'moj_xzfg' | 'gov_gjgzk' | 'moj_regulations'

export interface KnowledgeStatuteDocument {
  id: string
  title: string
  docType: string
  issuer: string
  effectiveStatus: 'effective' | 'amended' | 'repealed'
  effectiveDate: string
  publishDate: string
  revisionDate?: string
  version: string
  sourceUrl?: string
  sourceTextUrl?: string
  sourcePdfUrl?: string
  sourceProvider?: LegalSourceProvider
  sourceAuthority?: string
  sourceDocumentId?: string
  sourceVerifiedAt?: string
  keywords: string[]
  articles: KnowledgeStatuteArticle[]
}

export type KnowledgeFileKind = 'word' | 'pdf' | 'text' | 'other'
export type KnowledgeFileProcessingStatus = 'ready' | 'pending' | 'failed'

export interface KnowledgeFileRecord {
  id: string
  title: string
  fileName: string
  storageKey?: string
  storageUrl?: string
  fileExtension: string
  mimeType: string
  fileKind: KnowledgeFileKind
  uploadedAt: string
  updatedAt: string
  fileSize?: number
  extractionStatus: KnowledgeFileProcessingStatus
  extractionError?: string
  extractedText: string
  summary: string
  vectorStatus: KnowledgeFileProcessingStatus
  vectorError?: string
  vectorChunkCount: number
  vectorKeywords: string[]
  vectorUpdatedAt?: string
  linkedStatuteIds: string[]
}

export interface LegalSourceCatalogItem {
  id: LegalSourceProvider
  name: string
  authority: string
  homepage: string
  searchUrl: string
  coverage: string[]
  preferredDocTypes: string[]
  updateMode: 'scheduled-sync' | 'manual-sync'
  downloadFormats: Array<'html' | 'txt' | 'pdf' | 'wps'>
  notes: string
}

export interface WorkspaceState {
  user: UserAccount
  cases: CaseFolder[]
  evidences: Evidence[]
  evidenceFragments: EvidenceFragment[]
  evidenceInsights: EvidenceInsight[]
  caseContextMemories: CaseContextMemory[]
  draftMemories: DraftMemory[]
  certificates: Certificate[]
  claimUnits: ClaimUnit[]
  claimEvidenceMatches: ClaimEvidenceMatch[]
  knowledgeCases: KnowledgeCase[]
  knowledgeFiles: KnowledgeFileRecord[]
  knowledgeStatutes: KnowledgeStatuteDocument[]
  paymentOrders: RechargeOrder[]
}

export interface LoginPayload {
  account: string
  password: string
  loginType: 'password' | 'code'
}

export interface EvidenceImportPayload {
  caseId: string
  processInBackground?: boolean
  files: Array<{
    fileName: string
    relativePath?: string
    name: string
    type: EvidenceType
    ocrText: string
    previewDataUrl?: string
    sourceDataUrl?: string
    storageKey?: string
    storageUrl?: string
    pageImageDataUrls?: string[]
    sourceMimeType?: string
    pages?: number
    anchorHint?: string
    summaryText?: string
    summaryStatus?: 'idle' | 'processing' | 'ready' | 'failed'
    summaryError?: string
    summaryUpdatedAt?: string
    summaryCacheKey?: string
  }>
}

export interface GenerateCertificatePayload {
  caseId: string
  evidenceIds: string[]
  role: RoleType
  focus: string
  prompt?: string
}

export interface RewriteCertificatePayload {
  certificateId: string
  evidenceIds: string[]
  prompt: string
}

export interface ImportCertificatePayload {
  caseId: string
  title: string
  content: string
  sourceFileName: string
  paragraphs?: Array<{
    text: string
    richText?: string
  }>
}
