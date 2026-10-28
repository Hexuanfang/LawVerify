import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { Extension } from '@tiptap/core'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { exportCertificateToWord } from './export-word'
import { AttentionText, EvidenceAttention } from './EvidenceAttention'
import { AgentPromptInput, type AgentPromptInputHandle } from './AgentPromptInput'
import { IdeActivityBar, type IdeNavigationTarget } from './IdeActivityBar'
import { CaseAgentPanel } from './CaseAgentPanel'
import { CaseDirectorySync, syncDesktopDirectory, stopCaseDirectorySync, resumeCaseDirectorySync } from './CaseDirectorySync'
import { getAttentionTerms } from './evidence-attention'
import { createDocumentTaskQueue } from './document-task-queue'
import { draftKey, readDraft, removeDraft, writeDraft, type ParagraphDraft } from './draft-store'
import { StabilityBoundary } from './StabilityBoundary'
import { reportDiagnostic } from './stability-monitor'
import { readBoundedSource } from './bounded-fetch'
import { importWordContent } from './word-import'
import { VirtualList } from './VirtualList'
import { LegalReview, LegalReviewExtension } from './LegalReview'
import { CaseSearchPanel } from './CaseSearchPanel'
import { AccountFeatures } from './AccountFeatures'
const PdfPreview = lazy(() => import('./PdfPreview').then(module => ({ default: module.PdfPreview })))
import './App.css'
import { api, fetchWithWorkspaceAccount, getEvidenceSourceUrl, isCloudAuthApiError, watchWorkspace } from './api'
import type {
  AppState,
  CaseFolder,
  CertificateParagraph,
  Evidence,
  EvidenceLink,
  EvidenceType,
  KnowledgeCase,
  KnowledgeCaseExcerpt,
  KnowledgeFileRecord,
  KnowledgeStatuteArticle,
  KnowledgeStatuteDocument,
  LoginPayload,
  PaymentProvider,
  PaymentProviderStatus,
  ParagraphReference,
  PointActionType,
  RechargeOrder,
  RechargePackage,
  ReleaseItem,
} from './types'

const AUTH_STORAGE_KEY = 'lawverify-auth-session'
const CLOUD_TOKEN_STORAGE_KEY = 'lawverify-cloud-token'
const LOGIN_ACCOUNT_STORAGE_KEY = 'lawverify-login-account'
const STREAMLINED_SIDEBAR_COLLAPSED_STORAGE_KEY = 'lawverify-streamlined-sidebar-collapsed'
const STREAMLINED_SIDEBAR_WIDTH_STORAGE_KEY = 'lawverify-streamlined-sidebar-width'
const MAX_EVIDENCE_SOURCE_UPLOAD_BATCH_BYTES = 48_000_000
const MAX_EVIDENCE_SOURCE_UPLOAD_BATCH_COUNT = 18
const DEFAULT_GENERATION_ROLE = 'plaintiff'
const DEFAULT_GENERATION_FOCUS = '真实性、关联性与证明力'
const DEFAULT_STREAMLINED_SIDEBAR_WIDTH = 260
const MIN_STREAMLINED_SIDEBAR_WIDTH = 220
const MAX_STREAMLINED_SIDEBAR_WIDTH = 420
const COLLAPSED_STREAMLINED_SIDEBAR_WIDTH = 56
const STREAMLINED_SIDEBAR_COLLAPSE_THRESHOLD = 120
const MIN_STREAMLINED_MAIN_WIDTH = 720
const STREAMLINED_SIDEBAR_RESIZER_WIDTH = 6
const DEFAULT_INSIGHT_PANEL_WIDTH = 380
const PROGRESS_UPDATE_INTERVAL_MS = 80
const MAIN_THREAD_YIELD_INTERVAL_MS = 24
const MIN_INSIGHT_PANEL_WIDTH = 280
const MIN_DOCUMENT_PANEL_WIDTH = 360
const WORKBENCH_RESIZER_WIDTH = 6
const DEFAULT_KNOWLEDGE_FILES_SIDEBAR_WIDTH = 320
const MIN_KNOWLEDGE_FILES_SIDEBAR_WIDTH = 240
const MAX_KNOWLEDGE_FILES_SIDEBAR_WIDTH = 560
const KNOWLEDGE_FILES_SIDEBAR_RESIZER_WIDTH = 14
const AGENT_DOCK_MARGIN = 20
const AGENT_DOCK_COLLAPSED_SIZE = 68
const AGENT_DOCK_EXPANDED_WIDTH = 640
const AGENT_DOCK_EXPANDED_HEIGHT = 310
const OFFICIAL_PLATFORM_BASE_URL = 'https://lawagent.zhijing.fun'
const DEV_SERVICE_HOST = typeof window !== 'undefined'
  && window.location.hostname
  && window.location.hostname !== 'localhost'
  && window.location.hostname !== '127.0.0.1'
  ? window.location.hostname
  : '127.0.0.1'
const ACCOUNT_CENTER_BASE_URL = (
  import.meta.env.VITE_ACCOUNT_CENTER_URL?.trim()
  ?? (import.meta.env.DEV ? `http://${DEV_SERVICE_HOST}:4273` : OFFICIAL_PLATFORM_BASE_URL)
).replace(/\/$/, '')

type AppTab = 'overview' | 'workspace' | 'knowledge' | 'settings'
type CaseCenterTab = 'overview' | 'evidence' | 'draft' | 'review'
type PreviewPanelMode = 'preview' | 'text' | 'meta'
type KnowledgeTab = 'cases' | 'statutes' | 'saved'
type SettingsTab = 'files' | 'statutes'
type VerifyInsightTab = 'evidence' | 'statute' | 'case' | 'memory'
type ChargeablePointAction = Extract<PointActionType, 'evidence_summary' | 'pleading_full'>
type FeedbackType = 'bug' | 'suggestion' | 'experience' | 'other'
type EntryOnboardingStep = 'idle' | 'create-case' | 'link-folder'

const DEFAULT_POINT_POLICY_MAP: Record<ChargeablePointAction, number> = {
  evidence_summary: 2,
  pleading_full: 15,
}
const sentenceHighlightPluginKey = new PluginKey<{ activeSentenceIndex: number | null }>('lawverifySentenceHighlight')

interface SelectionState {
  selectedCaseId: string | null
  selectedCertificateId: string | null
  activeParagraphId: string | null
  selectedEvidenceIds: string[]
  locatorDraft: string
}

interface RechargeDialogState {
  providers: PaymentProviderStatus[]
  packages: RechargePackage[]
  selectedPackageId: string | null
  selectedChannel: PaymentProvider
  activeOrder: RechargeOrder | null
  qrCodeDataUrl: string
}

interface FeedbackDialogState {
  feedbackType: FeedbackType
  title: string
  content: string
  contact: string
}

interface AppUpdateState {
  status: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error'
  latestRelease: ReleaseItem | null
  progress: number | null
  message: string
}

interface CloudPointsSyncState {
  cloudPointsBalance: number
  cloudPointLogs: AppState['user']['pointLogs']
}

interface CloudAccountSessionProfile {
  email: string
  name: string
  organization?: string
  role?: string
}

interface DesktopRegisterForm {
  organizationName: string
  ownerName: string
  email: string
  password: string
  inviteCode?: string
}

interface CloudLedgerEntrySnapshot {
  id: string
  createdAt: string
  description: string
  delta: number
  balanceAfter: number
  entryType?: AppState['user']['pointLogs'][number]['type']
  actionType?: PointActionType
  operationKey?: string
}

function clampStreamlinedSidebarWidth(width: number, containerWidth?: number) {
  const maxWidth = containerWidth
    ? Math.min(
        MAX_STREAMLINED_SIDEBAR_WIDTH,
        Math.max(
          MIN_STREAMLINED_SIDEBAR_WIDTH,
          containerWidth - MIN_STREAMLINED_MAIN_WIDTH - STREAMLINED_SIDEBAR_RESIZER_WIDTH - 52,
        ),
      )
    : MAX_STREAMLINED_SIDEBAR_WIDTH

  return Math.min(Math.max(width, MIN_STREAMLINED_SIDEBAR_WIDTH), maxWidth)
}

interface DirectoryPickerFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
}

function PasswordVisibilityIcon({ visible }: { visible: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.7" />
      {visible ? null : <path d="M4 4l16 16" />}
    </svg>
  )
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 4.5h1.5v11H4z" fill="currentColor" stroke="none" />
      {collapsed ? (
        <path d="m8 6 4 4-4 4" />
      ) : (
        <path d="m12 6-4 4 4 4" />
      )}
    </svg>
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function clampAgentDockPosition(position: { x: number; y: number }, width: number, height: number) {
  if (typeof window === 'undefined') {
    return position
  }

  return {
    x: clamp(position.x, AGENT_DOCK_MARGIN, Math.max(AGENT_DOCK_MARGIN, window.innerWidth - width - AGENT_DOCK_MARGIN)),
    y: clamp(position.y, AGENT_DOCK_MARGIN, Math.max(AGENT_DOCK_MARGIN, window.innerHeight - height - AGENT_DOCK_MARGIN)),
  }
}

function getDefaultAgentDockPosition(width: number, height: number) {
  if (typeof window === 'undefined') {
    return { x: AGENT_DOCK_MARGIN, y: AGENT_DOCK_MARGIN }
  }

  return {
    x: Math.max(AGENT_DOCK_MARGIN, window.innerWidth - width - AGENT_DOCK_MARGIN),
    y: Math.max(AGENT_DOCK_MARGIN, window.innerHeight - height - AGENT_DOCK_MARGIN),
  }
}

function mergeWorkspaceWithCloudPoints(workspace: AppState, cloudPointsSyncState: CloudPointsSyncState | null) {
  if (!cloudPointsSyncState) {
    return workspace
  }

  return {
    ...workspace,
    user: {
      ...workspace.user,
      // 云端已包含消费和退款，本地历史扣费不能再次叠加。
      points: cloudPointsSyncState.cloudPointsBalance,
      pointLogs: cloudPointsSyncState.cloudPointLogs,
    },
  }
}

function mapCloudLedgerEntryToPointLog(entry: CloudLedgerEntrySnapshot): AppState['user']['pointLogs'][number] {
  return {
    id: entry.id,
    type: entry.entryType ?? (entry.delta >= 0 ? 'recharge' : 'consume'),
    amount: Math.abs(entry.delta),
    note: entry.description,
    createdAt: entry.createdAt,
  }
}

function enrichWorkspaceWithCloudProfile(workspace: AppState, profile: CloudAccountSessionProfile | null) {
  if (!profile) {
    return workspace
  }

  return {
    ...workspace,
    user: {
      ...workspace.user,
      email: profile.email || workspace.user.email,
      name: profile.name || workspace.user.name,
      organization: profile.organization || workspace.user.organization,
      title: profile.role || workspace.user.title,
    },
  }
}

function isEmailAccount(value: string) {
  return /\S+@\S+\.\S+/.test(value.trim())
}

function createPointOperationKey(actionType: PointActionType, resourceId?: string) {
  const seed = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return [actionType, resourceId?.trim(), seed].filter(Boolean).join(':')
}

interface DirectoryPickerDirectoryHandle {
  kind: 'directory'
  name: string
  values(): AsyncIterable<DirectoryPickerEntry>
}

type DirectoryPickerEntry = DirectoryPickerFileHandle | DirectoryPickerDirectoryHandle

interface EvidenceImportProgress {
  stage: 'scan' | 'parse'
  message: string
  completed: number
  total: number
}

interface ImageViewerState {
  src: string
  title: string
  scale: number
}

interface KnowledgeUploadProgress {
  stage: 'prepare' | 'upload' | 'extract' | 'complete' | 'failed'
  message: string
  fileNames: string[]
  total: number
  source: 'file' | 'folder'
}

interface KnowledgeReindexProgress {
  stage: 'prepare' | 'extract' | 'complete' | 'failed'
  fileId: string
  fileName: string
  mode: 'reindex' | 'vectorize'
  message: string
}

interface AgentMessage {
  id: string
  role: 'assistant' | 'user'
  content: string
}

interface CaseDialogState {
  mode: 'create' | 'rename'
  caseId?: string
  title: string
  confirmLabel: string
  value: string
}

interface StreamingCertificatePreview {
  mode: 'generate' | 'rewrite'
  title: string
  focus: string
  createdAt: string
  paragraphs: Array<{
    id: string
    text: string
  }>
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatFenToCurrency(amountFen: number) {
  return `¥${(amountFen / 100).toFixed(2)}`
}

function getAccountCenterBillingUrl(cloudToken?: string | null) {
  const billingUrl = new URL(`${ACCOUNT_CENTER_BASE_URL}/console/billing`)
  const normalizedToken = cloudToken?.trim()
  if (normalizedToken) {
    billingUrl.searchParams.set('desktopToken', normalizedToken)
  }

  return billingUrl.toString()
}

function getAccountCenterRegisterUrl() {
  return `${ACCOUNT_CENTER_BASE_URL}/register`
}

function isLocalOriginUrl(url: string) {
  try {
    const parsed = new URL(url)
    const { protocol, hostname } = parsed
    if (!/^https?:$/i.test(protocol)) {
      return false
    }

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return true
    }

    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true
    }

    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true
    }

    const match = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
    if (match) {
      const secondOctet = Number(match[1])
      return secondOctet >= 16 && secondOctet <= 31
    }

    return false
  } catch {
    return false
  }
}

async function openExternalUrl(url: string) {
  if (typeof window !== 'undefined' && window.lawVerifyDesktop?.openExternal) {
    await window.lawVerifyDesktop.openExternal(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

function parseVersionSegments(version: string) {
  const matches = String(version).match(/\d+/g)
  return matches ? matches.map((item) => Number(item)) : []
}

function compareAppVersions(currentVersion: string, nextVersion: string) {
  const left = parseVersionSegments(currentVersion)
  const right = parseVersionSegments(nextVersion)
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    if (leftValue === rightValue) {
      continue
    }

    return leftValue > rightValue ? 1 : -1
  }

  return 0
}

function getPaymentProviderLabel(provider: PaymentProvider) {
  return provider === 'alipay' ? '支付宝' : '微信支付'
}

function getRechargeOrderStatusLabel(status: RechargeOrder['status']) {
  if (status === 'paid') {
    return '已支付'
  }

  if (status === 'closed') {
    return '已关闭'
  }

  if (status === 'failed') {
    return '支付失败'
  }

  return '待支付'
}

function getRechargeOrderStatusTone(status: RechargeOrder['status']) {
  if (status === 'paid') {
    return 'ready'
  }

  if (status === 'pending') {
    return 'in_review'
  }

  return 'draft'
}

function getEvidenceType(fileName: string, mimeType: string): EvidenceType {
  if (mimeType.includes('pdf') || fileName.endsWith('.pdf')) {
    return 'pdf'
  }

  if (
    mimeType.includes('powerpoint') ||
    mimeType.includes('presentation') ||
    fileName.endsWith('.ppt') ||
    fileName.endsWith('.pptx')
  ) {
    return 'ppt'
  }

  if (mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName)) {
    return 'image'
  }

  if (
    mimeType.includes('word') ||
    mimeType.includes('wordprocessingml') ||
    mimeType.includes('rtf') ||
    /\.(docx?|rtf|wps)$/i.test(fileName)
  ) {
    return 'word'
  }

  if (
    mimeType.startsWith('text/') ||
    fileName.endsWith('.txt') ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.json')
  ) {
    return 'text'
  }

  return 'other'
}

function getMonotonicNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

async function yieldToMainThread() {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

interface ProgressLoopState {
  lastProgressAt: number
  lastYieldAt: number
}

function createProgressLoopState(): ProgressLoopState {
  const now = getMonotonicNow()
  return {
    lastProgressAt: now,
    lastYieldAt: now,
  }
}

function shouldFlushProgress(state: ProgressLoopState, force = false) {
  if (force) {
    state.lastProgressAt = getMonotonicNow()
    return true
  }

  const now = getMonotonicNow()
  if (now - state.lastProgressAt < PROGRESS_UPDATE_INTERVAL_MS) {
    return false
  }

  state.lastProgressAt = now
  return true
}

async function yieldWhenBusy(state: ProgressLoopState) {
  const now = getMonotonicNow()
  if (now - state.lastYieldAt < MAIN_THREAD_YIELD_INTERVAL_MS) {
    return
  }

  await yieldToMainThread()
  state.lastYieldAt = getMonotonicNow()
}

function getSourceMimeType(fileName: string, mimeType: string, evidenceType: EvidenceType) {
  if (mimeType) {
    return mimeType
  }

  if (evidenceType === 'pdf') {
    return 'application/pdf'
  }

  if (evidenceType === 'ppt') {
    return fileName.endsWith('.ppt')
      ? 'application/vnd.ms-powerpoint'
      : 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }

  if (evidenceType === 'word') {
    if (fileName.endsWith('.doc')) {
      return 'application/msword'
    }

    if (fileName.endsWith('.rtf')) {
      return 'application/rtf'
    }

    if (fileName.endsWith('.wps')) {
      return 'application/vnd.ms-works'
    }

    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }

  if (evidenceType === 'text') {
    return 'text/plain'
  }

  if (evidenceType === 'image') {
    return 'image/*'
  }

  return 'application/octet-stream'
}

function getKnowledgeFileKindLabel(kind: KnowledgeFileRecord['fileKind']) {
  if (kind === 'word') {
    return 'Word'
  }

  if (kind === 'pdf') {
    return 'PDF'
  }

  if (kind === 'text') {
    return '文本'
  }

  return '其他'
}

function getKnowledgeCaseSourceLabel(sourceType: string) {
  const normalized = sourceType.trim()
  if (!normalized) {
    return '案例库'
  }

  return normalized.replace(/MCP$/u, ' MCP')
}

function isSupportedKnowledgeImportFile(fileName: string) {
  return /\.(docx|doc|rtf|txt|md|markdown|pdf|wps)$/i.test(fileName)
}

function getProcessingStatusLabel(status: KnowledgeFileRecord['extractionStatus']) {
  if (status === 'ready') {
    return '已完成'
  }

  if (status === 'failed') {
    return '失败'
  }

  return '待处理'
}

function getKnowledgeUploadStageLabel(stage: KnowledgeUploadProgress['stage']) {
  if (stage === 'prepare') {
    return '准备中'
  }

  if (stage === 'upload') {
    return '上传中'
  }

  if (stage === 'extract') {
    return '处理中'
  }

  if (stage === 'complete') {
    return '已完成'
  }

  return '失败'
}

function getKnowledgeUploadStageTone(stage: KnowledgeUploadProgress['stage']) {
  if (stage === 'complete') {
    return 'ready'
  }

  if (stage === 'failed') {
    return 'draft'
  }

  return 'in_review'
}

function getKnowledgeUploadSteps(progress: KnowledgeUploadProgress) {
  const stages: Array<{ key: KnowledgeUploadProgress['stage']; label: string }> = [
    { key: 'prepare', label: '准备文件' },
    { key: 'upload', label: '上传到知识库' },
    { key: 'extract', label: '抽取正文并入库' },
  ]
  const stageOrder: Record<KnowledgeUploadProgress['stage'], number> = {
    prepare: 0,
    upload: 1,
    extract: 2,
    complete: 2,
    failed: 0,
  }
  const activeIndex = stageOrder[progress.stage]

  return stages.map((item, index) => ({
    ...item,
    state: progress.stage === 'failed'
      ? (index === activeIndex ? 'failed' : 'pending')
      : index < activeIndex
        ? 'done'
        : index === activeIndex
          ? (progress.stage === 'complete' ? 'done' : 'active')
          : 'pending',
  }))
}

function getKnowledgeReindexStageLabel(stage: KnowledgeReindexProgress['stage']) {
  if (stage === 'prepare') {
    return '准备中'
  }

  if (stage === 'extract') {
    return '处理中'
  }

  if (stage === 'complete') {
    return '已完成'
  }

  return '失败'
}

function getKnowledgeReindexStageTone(stage: KnowledgeReindexProgress['stage']) {
  if (stage === 'complete') {
    return 'ready'
  }

  if (stage === 'failed') {
    return 'draft'
  }

  return 'in_review'
}

function getKnowledgeReindexSteps(progress: KnowledgeReindexProgress) {
  const labels = progress.mode === 'vectorize'
    ? ['读取当前正文', '重建向量索引']
    : ['读取原始文件', '抽取正文并重建索引']
  const stageOrder: Record<KnowledgeReindexProgress['stage'], number> = {
    prepare: 0,
    extract: 1,
    complete: 1,
    failed: 0,
  }
  const activeIndex = stageOrder[progress.stage]

  return labels.map((label, index) => ({
    key: `${progress.mode}-${index}`,
    label,
    state: progress.stage === 'failed'
      ? (index === activeIndex ? 'failed' : 'pending')
      : index < activeIndex
        ? 'done'
        : index === activeIndex
          ? (progress.stage === 'complete' ? 'done' : 'active')
          : 'pending',
  }))
}

function buildOcrPlaceholder(fileName: string, evidenceType: EvidenceType) {
  const kindLabel: Record<EvidenceType, string> = {
    pdf: 'PDF 分页抽文本',
    ppt: 'PPT 页面提取',
    image: '图片 OCR',
    word: 'Word 段落抽取',
    text: '文本直读',
    other: '通用文件预处理',
  }

  return [
    `【${kindLabel[evidenceType]}】`,
    `文件：${fileName}`,
    '1. 当前内容为文档抽取结果。',
    '2. 请结合原件完成人工校核。',
    '3. 可直接用于质证书生成与审核定位。',
  ].join('\n')
}

function normalizeRelativePath(value: string | undefined, fallback: string) {
  const normalized = value?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return normalized || fallback
}

function getFileStem(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '')
}

function cleanupEvidenceNameSegment(value: string) {
  const normalized = value
    .replace(/\.[^.]+$/, '')
    .replace(/^[\s._-]*[([{（【]?\d{1,3}[)\]）】._-]*/u, '')
    .replace(/^[\s._-]*(证据|附件|附证|材料)[\s._-]*\d{1,3}[\s._-]*/u, '')
    .replace(/_/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return normalized || getFileStem(value).trim()
}

function buildNormalizedEvidenceName(fileName: string, relativePath?: string) {
  const normalizedPath = normalizeRelativePath(relativePath, fileName)
  const segments = normalizedPath.split('/').filter(Boolean)
  const folderSegments = segments.slice(1, -1)
  const contextSegments = folderSegments.slice(-2).map(cleanupEvidenceNameSegment).filter(Boolean)
  const baseName = cleanupEvidenceNameSegment(segments[segments.length - 1] ?? fileName)
  const mergedSegments = [...contextSegments, baseName].filter(Boolean)
  const dedupedSegments = mergedSegments.filter((segment, index) =>
    mergedSegments.findIndex((candidate) => candidate.toLowerCase() === segment.toLowerCase()) === index,
  )
  const candidate = dedupedSegments.join(' - ').trim()

  return candidate || getFileStem(fileName)
}

function sortImportedFiles<T extends File & { webkitRelativePath?: string }>(fileList: T[]) {
  return [...fileList].sort((left, right) =>
    getRelativePathFromFile(left).localeCompare(getRelativePathFromFile(right), 'zh-CN'),
  )
}

function getRelativePathFromFile(file: File) {
  const browserFile = file as File & { webkitRelativePath?: string }
  return normalizeRelativePath(browserFile.webkitRelativePath, file.name)
}

function getEvidencePreviewSourceKey(evidence: Pick<Evidence, 'relativePath' | 'fileName'>) {
  return normalizeRelativePath(evidence.relativePath, evidence.fileName).toLowerCase()
}

function buildLocalPreviewSourceMap(fileList: Array<File & { webkitRelativePath?: string }>) {
  const entries: Record<string, string> = {}

  for (const file of fileList) {
    const type = getEvidenceType(file.name.toLowerCase(), file.type)

    if (type !== 'image' && type !== 'pdf' && type !== 'word') {
      continue
    }

    entries[getEvidencePreviewSourceKey({
      relativePath: getRelativePathFromFile(file),
      fileName: file.name,
    })] = URL.createObjectURL(file)
  }

  return entries
}

function stripRtfControlText(input: string) {
  return input
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\tab/g, ' ')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+\d* ?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function buildImportedParagraphDraftsFromHtml(html: string) {
  if (typeof DOMParser === 'undefined') {
    const text = extractPlainTextFromHtml(html)
    return text ? [{ text, richText: buildParagraphRichText(text) }] : []
  }

  const parser = new DOMParser()
  const documentNode = parser.parseFromString(html, 'text/html')
  const blocks = Array.from(documentNode.body.children)
    .map((element) => {
      const richText = element.outerHTML.trim()
      const text = extractPlainTextFromHtml(richText)
      return { text, richText }
    })
    .filter((item) => item.text.trim())

  if (blocks.length) {
    return blocks
  }

  const fallbackText = extractPlainTextFromHtml(html)
  return fallbackText ? [{ text: fallbackText, richText: buildParagraphRichText(fallbackText) }] : []
}

async function collectFilesFromDirectoryHandle(
  handle: DirectoryPickerDirectoryHandle,
  currentPath = handle.name,
  onProgress?: (progress: EvidenceImportProgress) => void,
  tracker = { discovered: 0, loopState: createProgressLoopState() },
): Promise<Array<File & { webkitRelativePath?: string }>> {
  const files: Array<File & { webkitRelativePath?: string }> = []

  for await (const entry of handle.values()) {
    if (entry.kind === 'file') {
      const file = await entry.getFile()
      const type = getEvidenceType(file.name.toLowerCase(), file.type)
      if (type === 'other') {
        continue
      }
      
      const fileWithPath = file as File & { webkitRelativePath?: string }
      Object.defineProperty(fileWithPath, 'webkitRelativePath', {
        value: `${currentPath}/${entry.name}`,
        configurable: true,
      })
      files.push(fileWithPath)
      tracker.discovered += 1
      if (shouldFlushProgress(tracker.loopState)) {
        onProgress?.({
          stage: 'scan',
          message: `正在扫描目录，已发现 ${tracker.discovered} 个文件`,
          completed: tracker.discovered,
          total: 0,
        })
      }
      await yieldWhenBusy(tracker.loopState)
      continue
    }

    files.push(...await collectFilesFromDirectoryHandle(entry, `${currentPath}/${entry.name}`, onProgress, tracker))
    await yieldWhenBusy(tracker.loopState)
  }

  return files
}

function getEvidenceDirectoryParts(evidence: Pick<Evidence, 'relativePath' | 'fileName'>) {
  const relativePath = normalizeRelativePath(evidence.relativePath, evidence.fileName)
  const segments = relativePath.split('/').filter(Boolean)

  return {
    relativePath,
    folderKey: segments.length > 1 ? segments.slice(0, -1).join('/') : '',
    folderLabel: segments.length > 1 ? segments.slice(0, -1).join(' / ') : '根目录',
  }
}

function isPlaceholderStatuteContent(content?: string) {
  if (!content?.trim()) {
    return true
  }

  return content.includes('官方原文已定位') || content.includes('当前官方接口未直接返回结构化正文')
}

function isJudicialInterpretationDocument(document: KnowledgeStatuteDocument) {
  return document.docType.includes('司法解释') || document.issuer.includes('最高人民法院')
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeStatuteLookupText(value: string) {
  return value
    .replace(/\s+/g, '')
    .replace(/[《》"'“”‘’]/g, '')
    .trim()
}

function extractArticlePreviewFromKnowledgeFile(file: KnowledgeFileRecord, articleNumber: string) {
  const rawText = file.extractedText?.trim()
  if (!rawText) {
    return null
  }

  const escapedArticleNumber = escapeRegex(articleNumber)
  const articlePattern = new RegExp(
    `(${escapedArticleNumber}[\\s\\S]{0,2400}?)(?=\\n\\s*第[一二三四五六七八九十百千万零〇两0-9]+条|$)`,
    'u',
  )
  const matched = rawText.match(articlePattern)
  if (!matched?.[1]) {
    return null
  }

  const preview = matched[1]
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return preview || null
}

function findKnowledgeFileStatutePreview(
  files: KnowledgeFileRecord[],
  document: KnowledgeStatuteDocument | null,
  article: KnowledgeStatuteArticle | null,
) {
  if (!document || !article) {
    return null
  }

  const normalizedTitle = normalizeStatuteLookupText(document.title)
  const candidates = files
    .filter((file) => file.extractionStatus === 'ready' && file.extractedText?.trim())
    .map((file) => {
      const normalizedFileTitle = normalizeStatuteLookupText(`${file.title} ${file.fileName}`)
      const titleMatched = normalizedFileTitle.includes(normalizedTitle) || normalizedTitle.includes(normalizedFileTitle)
      const explicitlyLinked = file.linkedStatuteIds.includes(document.id)
      const articlePreview = extractArticlePreviewFromKnowledgeFile(file, article.articleNumber)

      if (!articlePreview) {
        return null
      }

      return {
        file,
        articlePreview,
        score: (explicitlyLinked ? 10 : 0) + (titleMatched ? 6 : 0),
      }
    })
    .filter((item): item is { file: KnowledgeFileRecord; articlePreview: string; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score || right.file.updatedAt.localeCompare(left.file.updatedAt))

  return candidates[0] ?? null
}

function findBestStatuteBindingForReference(
  documents: KnowledgeStatuteDocument[],
  reference: ParagraphReference | null,
) {
  if (!reference) {
    return null
  }

  let fallback: { document: KnowledgeStatuteDocument; article: KnowledgeStatuteArticle } | null = null

  for (const document of documents) {
    for (const article of document.articles) {
      if (article.id === reference.targetId) {
        fallback = { document, article }
      }

      if (
        document.title === reference.sourceTitle
        && article.articleNumber === reference.locator
        && !isPlaceholderStatuteContent(article.content)
      ) {
        return { document, article }
      }
    }
  }

  return fallback
}

function buildRelatedInterpretationArticles(
  documents: KnowledgeStatuteDocument[],
  document: KnowledgeStatuteDocument | null,
  article: KnowledgeStatuteArticle | null,
) {
  if (!document || !article) {
    return []
  }

  const query = [
    document.title,
    ...document.keywords,
    article.articleNumber,
    article.content,
    ...article.aliases,
    ...article.topicTags,
  ].join(' ')

  return documents
    .filter((entry) => entry.id !== document.id && isJudicialInterpretationDocument(entry))
    .flatMap((entry) =>
      entry.articles.map((item) => ({
        document: entry,
        article: item,
        score: scoreByKeywordOverlap(query, [
          entry.title,
          entry.docType,
          entry.issuer,
          ...entry.keywords,
          item.articleNumber,
          item.content,
          ...item.aliases,
          ...item.topicTags,
        ]),
      })),
    )
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
}

interface SentenceRange {
  index: number
  text: string
  start: number
  end: number
}

interface SentenceAnchorLike {
  sentenceIndex?: number
  sentenceText?: string
  quote?: string
}

interface EditorTextSegment {
  text: string
  start: number
  end: number
  from: number
  to: number
}

function normalizeSentenceAnchorText(text: string | undefined | null) {
  return text?.replace(/\s+/g, '').trim().toLowerCase() ?? ''
}

function splitSentenceRanges(text: string): SentenceRange[] {
  const source = text.replace(/\r/g, '')
  const matches = Array.from(source.matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu))
    .map((match, index) => {
      const rawText = match[0] ?? ''
      const rawStart = match.index ?? 0
      const leadingWhitespace = rawText.length - rawText.trimStart().length
      const trailingWhitespace = rawText.length - rawText.trimEnd().length
      const start = rawStart + leadingWhitespace
      const end = rawStart + rawText.length - trailingWhitespace
      const sentenceText = source.slice(start, end).trim()

      if (!sentenceText) {
        return null
      }

      return {
        index,
        text: sentenceText,
        start,
        end,
      } satisfies SentenceRange
    })
    .filter((item): item is SentenceRange => Boolean(item))

  if (matches.length) {
    return matches
  }

  const fallback = source.trim()
  return fallback
    ? [{
        index: 0,
        text: fallback,
        start: source.indexOf(fallback),
        end: source.indexOf(fallback) + fallback.length,
      }]
    : []
}

function resolveSentenceSelection(
  text: string,
  anchor?: {
    sentenceIndex?: number | null
    sentenceText?: string | null
    fallbackText?: string | null
  },
) {
  const ranges = splitSentenceRanges(text)
  if (!ranges.length) {
    return {
      index: null,
      text: text.trim(),
    }
  }

  if (typeof anchor?.sentenceIndex === 'number' && ranges[anchor.sentenceIndex]) {
    return {
      index: ranges[anchor.sentenceIndex].index,
      text: ranges[anchor.sentenceIndex].text,
    }
  }

  const candidates = [anchor?.sentenceText, anchor?.fallbackText]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeSentenceAnchorText(candidate)
    if (!normalizedCandidate) {
      continue
    }

    const exactMatch = ranges.find((item) => normalizeSentenceAnchorText(item.text) === normalizedCandidate)
    if (exactMatch) {
      return {
        index: exactMatch.index,
        text: exactMatch.text,
      }
    }

    const fuzzyMatch = ranges.find((item) => {
      const normalizedSentence = normalizeSentenceAnchorText(item.text)
      return normalizedSentence.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedSentence)
    })
    if (fuzzyMatch) {
      return {
        index: fuzzyMatch.index,
        text: fuzzyMatch.text,
      }
    }
  }

  return {
    index: ranges[0].index,
    text: ranges[0].text,
  }
}

function resolveParagraphSentenceSelection(
  paragraph: CertificateParagraph | null | undefined,
  anchor?: SentenceAnchorLike | null,
) {
  if (!paragraph) {
    return {
      index: null,
      text: '',
    }
  }

  return resolveSentenceSelection(paragraph.text, {
    sentenceIndex: anchor?.sentenceIndex ?? null,
    sentenceText: anchor?.sentenceText ?? null,
    fallbackText: anchor?.quote ?? null,
  })
}

function sentenceAnchorMatches(
  anchor: SentenceAnchorLike | null | undefined,
  selection: { index: number | null; text: string },
) {
  if (selection.index == null) {
    return false
  }

  if (typeof anchor?.sentenceIndex === 'number') {
    return anchor.sentenceIndex === selection.index
  }

  const normalizedSentenceText = normalizeSentenceAnchorText(selection.text)
  const normalizedAnchorText = normalizeSentenceAnchorText(anchor?.sentenceText)
  return Boolean(
    normalizedSentenceText
    && normalizedAnchorText
    && (
      normalizedAnchorText === normalizedSentenceText
      || normalizedAnchorText.includes(normalizedSentenceText)
      || normalizedSentenceText.includes(normalizedAnchorText)
    ),
  )
}

function buildEditorTextSegments(doc: ProseMirrorNode) {
  const segments: EditorTextSegment[] = []
  let plainTextOffset = 0

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) {
      return
    }

    segments.push({
      text: node.text,
      start: plainTextOffset,
      end: plainTextOffset + node.text.length,
      from: pos,
      to: pos + node.text.length,
    })
    plainTextOffset += node.text.length
  })

  return segments
}

function resolveDocRangeFromSentenceIndex(doc: ProseMirrorNode, sentenceIndex: number | null) {
  if (sentenceIndex == null) {
    return null
  }

  const segments = buildEditorTextSegments(doc)
  if (!segments.length) {
    return null
  }

  const plainText = segments.map((item) => item.text).join('')
  const sentence = splitSentenceRanges(plainText)[sentenceIndex]
  if (!sentence) {
    return null
  }

  const startSegment = segments.find((item) => sentence.start >= item.start && sentence.start < item.end)
  const endOffset = Math.max(sentence.start, sentence.end - 1)
  const endSegment = segments.find((item) => endOffset >= item.start && endOffset < item.end)
  if (!startSegment || !endSegment) {
    return null
  }

  return {
    from: startSegment.from + (sentence.start - startSegment.start),
    to: endSegment.from + (endOffset - endSegment.start) + 1,
  }
}

function resolveSentenceSelectionFromEditor(editor: Editor) {
  const segments = buildEditorTextSegments(editor.state.doc)
  if (!segments.length) {
    return null
  }

  const plainText = segments.map((item) => item.text).join('')
  const sentences = splitSentenceRanges(plainText)
  if (!sentences.length) {
    return null
  }

  const position = editor.state.selection.from
  const segment = segments.find((item) => position >= item.from && position <= item.to) ?? segments[segments.length - 1]
  const offsetWithinSegment = Math.max(0, Math.min(segment.text.length - 1, position - segment.from))
  const plainTextOffset = segment.start + offsetWithinSegment
  const sentence = sentences.find((item) => plainTextOffset >= item.start && plainTextOffset < item.end) ?? sentences[sentences.length - 1]

  return {
    index: sentence.index,
    text: sentence.text,
  }
}

const SentenceHighlightExtension = Extension.create({
  name: 'sentenceHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<{ activeSentenceIndex: number | null }>({
        key: sentenceHighlightPluginKey,
        state: {
          init: () => ({ activeSentenceIndex: null as number | null }),
          apply(tr, value) {
            const next = tr.getMeta(sentenceHighlightPluginKey) as { activeSentenceIndex?: number | null } | undefined
            if (next && 'activeSentenceIndex' in next) {
              return {
                activeSentenceIndex: typeof next.activeSentenceIndex === 'number' ? next.activeSentenceIndex : null,
              }
            }

            return value
          },
        },
        props: {
          decorations(state) {
            const pluginState = sentenceHighlightPluginKey.getState(state) as { activeSentenceIndex: number | null } | undefined
            const range = resolveDocRangeFromSentenceIndex(state.doc, pluginState?.activeSentenceIndex ?? null)
            if (!range) {
              return DecorationSet.empty
            }

            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, {
                class: 'tiptap-active-sentence',
              }),
            ])
          },
        },
      }),
    ]
  },
})

function groupEvidencesByFolder(evidences: Evidence[]) {
  const groups = new Map<string, { key: string; label: string; evidences: Evidence[] }>()

  for (const evidence of [...evidences].sort((left, right) => {
    const leftPath = getEvidenceDirectoryParts(left).relativePath
    const rightPath = getEvidenceDirectoryParts(right).relativePath
    return leftPath.localeCompare(rightPath, 'zh-CN')
  })) {
    const { folderKey, folderLabel } = getEvidenceDirectoryParts(evidence)
    const group = groups.get(folderKey)

    if (group) {
      group.evidences.push(evidence)
      continue
    }

    groups.set(folderKey, {
      key: folderKey,
      label: folderLabel,
      evidences: [evidence],
    })
  }

  return Array.from(groups.values())
}

interface EvidenceFolderTreeNode {
  key: string
  label: string
  depth: number
  folders: EvidenceFolderTreeNode[]
  evidences: Evidence[]
}

type EvidenceTreeRow = { key: string; depth: number; label?: string; evidence?: Evidence }
const evidenceRowKey = (row: EvidenceTreeRow) => row.key
const evidenceRowHeight = (row: EvidenceTreeRow) => row.evidence ? 78 : 32
function flattenEvidenceTree(node: EvidenceFolderTreeNode, rows: EvidenceTreeRow[] = []) {
  if (node.key) rows.push({ key: `folder:${node.key}`, depth: node.depth, label: node.label })
  for (const folder of node.folders) flattenEvidenceTree(folder, rows)
  for (const evidence of node.evidences) rows.push({ key: evidence.id, depth: node.depth, evidence })
  return rows
}

function getEvidenceDisplayFileName(evidence: Pick<Evidence, 'fileName' | 'relativePath'>) {
  const relativePath = normalizeRelativePath(evidence.relativePath, evidence.fileName)
  const segments = relativePath.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? evidence.fileName
}

function buildPendingEvidenceItems(
  caseId: string,
  fileList: Array<File & { webkitRelativePath?: string }>,
): Evidence[] {
  const timestamp = new Date().toISOString()

  return sortImportedFiles(fileList).map((file, index) => {
    const type = getEvidenceType(file.name.toLowerCase(), file.type)
    const relativePath = getRelativePathFromFile(file)

    return {
      id: `pending-evidence-${index + 1}`,
      caseId,
      number: `E${String(index + 1).padStart(2, '0')}`,
      name: buildNormalizedEvidenceName(file.name, relativePath),
      type,
      fileName: file.name,
      relativePath,
      uploadedAt: timestamp,
      ocrText: '',
      pages: type === 'pdf' ? 3 : 1,
      anchorHint: type === 'image' ? '图片框选区域' : '段落 1',
      sourceMimeType: getSourceMimeType(file.name.toLowerCase(), file.type, type),
    }
  })
}

function buildEvidenceFolderTree(evidences: Evidence[]) {
  const root: EvidenceFolderTreeNode = {
    key: '',
    label: '根目录',
    depth: 0,
    folders: [],
    evidences: [],
  }
  const folderMap = new Map<string, EvidenceFolderTreeNode>([['', root]])

  const sortedEvidences = [...evidences].sort((left, right) =>
    getEvidenceDirectoryParts(left).relativePath.localeCompare(getEvidenceDirectoryParts(right).relativePath, 'zh-CN'),
  )

  for (const evidence of sortedEvidences) {
    const relativePath = getEvidenceDirectoryParts(evidence).relativePath
    const segments = relativePath.split('/').filter(Boolean)
    const folderSegments = segments.slice(0, -1)
    let currentPath = ''
    let parentNode = root

    for (const [folderIndex, folderName] of folderSegments.entries()) {
      currentPath = currentPath ? `${currentPath}/${folderName}` : folderName
      const existing = folderMap.get(currentPath)

      if (existing) {
        parentNode = existing
        continue
      }

      const nextNode: EvidenceFolderTreeNode = {
        key: currentPath,
        label: folderName,
        depth: folderIndex + 1,
        folders: [],
        evidences: [],
      }

      parentNode.folders.push(nextNode)
      folderMap.set(currentPath, nextNode)
      parentNode = nextNode
    }

    parentNode.evidences.push(evidence)
  }

  const sortTree = (node: EvidenceFolderTreeNode) => {
    node.folders.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
    node.evidences.sort((left, right) =>
      getEvidenceDisplayFileName(left).localeCompare(getEvidenceDisplayFileName(right), 'zh-CN'),
    )
    node.folders.forEach(sortTree)
  }

  sortTree(root)

  return root
}

function countEvidenceFolderTree(node: EvidenceFolderTreeNode): number {
  return node.folders.reduce((total, folder) => total + 1 + countEvidenceFolderTree(folder), 0)
}

function getParagraphLinks(paragraph: CertificateParagraph | null | undefined) {
  if (!paragraph) {
    return []
  }

  return paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []
}

function getLinkKey(link: EvidenceLink, index: number) {
  return link.id ?? `${link.evidenceId}-${link.locator}-${index}`
}

function normalizeWorkspaceState(workspace: AppState): AppState {
  return {
    ...workspace,
    certificates: workspace.certificates.map((certificate) => ({
      ...certificate,
      paragraphs: certificate.paragraphs.map((paragraph) => ({
        ...paragraph,
        richText: paragraph.richText ?? buildParagraphRichText(paragraph.text),
      })),
    })),
    evidenceFragments: workspace.evidenceFragments ?? [],
    evidenceInsights: workspace.evidenceInsights ?? [],
    caseContextMemories: workspace.caseContextMemories ?? [],
    draftMemories: workspace.draftMemories ?? [],
    claimUnits: workspace.claimUnits ?? [],
    claimEvidenceMatches: workspace.claimEvidenceMatches ?? [],
    knowledgeCases: workspace.knowledgeCases ?? [],
    knowledgeFiles: workspace.knowledgeFiles ?? [],
    knowledgeStatutes: workspace.knowledgeStatutes ?? [],
    paymentOrders: workspace.paymentOrders ?? [],
  }
}

function getParagraphReferences(
  paragraph: CertificateParagraph | null | undefined,
  type?: ParagraphReference['type'],
) {
  const references = paragraph?.references ?? []
  return type ? references.filter((item) => item.type === type) : references
}

function getReferenceKey(reference: ParagraphReference, index: number) {
  return reference.id ?? `${reference.type}-${reference.targetId}-${index}`
}

function getReferenceIdentity(reference: ParagraphReference) {
  return reference.id ?? `${reference.type}-${reference.targetId}`
}

function buildKeywordTokens(text: string) {
  return text
    .toLowerCase()
    .split(/[\s,.;:，。；：、()（）【】\[\]\-_/]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
}

function scoreByKeywordOverlap(query: string, candidates: string[]) {
  const tokens = buildKeywordTokens(query)
  if (!tokens.length) {
    return 0
  }

  return tokens.reduce(
    (total, token) => total + (candidates.some((item) => item.toLowerCase().includes(token)) ? 1 : 0),
    0,
  )
}

function deriveSelection(
  workspace: AppState,
  current: Partial<SelectionState> = {},
): SelectionState {
  const explicitCertificate = current.selectedCertificateId
    ? workspace.certificates.find((item) => item.id === current.selectedCertificateId) ?? null
    : null

  const selectedCaseId =
    explicitCertificate?.caseId
    ?? (
      current.selectedCaseId && workspace.cases.some((item) => item.id === current.selectedCaseId)
      ? current.selectedCaseId
      : workspace.cases[0]?.id ?? null
    )

  const caseEvidences = workspace.evidences.filter((item) => item.caseId === selectedCaseId)
  const caseCertificates = workspace.certificates
    .filter((item) => item.caseId === selectedCaseId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const selectedCertificateId =
    current.selectedCertificateId &&
    caseCertificates.some((item) => item.id === current.selectedCertificateId)
      ? current.selectedCertificateId
      : caseCertificates[0]?.id ?? null

  const activeCertificate = caseCertificates.find((item) => item.id === selectedCertificateId) ?? null
  const activeParagraphId =
    current.activeParagraphId &&
    activeCertificate?.paragraphs.some((item) => item.id === current.activeParagraphId)
      ? current.activeParagraphId
      : activeCertificate?.paragraphs[0]?.id ?? null

  const activeParagraph =
    activeCertificate?.paragraphs.find((item) => item.id === activeParagraphId) ?? null

  const selectedEvidenceIds =
    current.selectedEvidenceIds &&
    current.selectedEvidenceIds.length > 0 &&
    current.selectedEvidenceIds.every((item) => caseEvidences.some((evidence) => evidence.id === item))
      ? current.selectedEvidenceIds
      : caseEvidences.map((item) => item.id)

  return {
    selectedCaseId,
    selectedCertificateId,
    activeParagraphId,
    selectedEvidenceIds,
    locatorDraft: getParagraphLinks(activeParagraph)[0]?.locator ?? '段落 1',
  }
}

function getStatusLabel(status: CaseFolder['status']) {
  const map: Record<CaseFolder['status'], string> = {
    draft: '筹备中',
    in_review: '核验中',
    ready: '待归档',
  }
  return map[status]
}

function getEffectiveStatusLabel(status: KnowledgeStatuteDocument['effectiveStatus']) {
  const map: Record<KnowledgeStatuteDocument['effectiveStatus'], string> = {
    effective: '现行有效',
    amended: '修订生效',
    repealed: '已失效',
  }
  return map[status]
}

function getEvidenceFormatLabel(evidence: Evidence) {
  const labels: Record<EvidenceType, string> = {
    pdf: 'PDF 原件',
    ppt: 'PPT 文稿',
    image: '图片原件',
    word: 'Word 文稿',
    text: '文本材料',
    other: '通用材料',
  }

  return labels[evidence.type]
}

function isDocxEvidence(evidence: Evidence) {
  const lowerFileName = evidence.fileName.toLowerCase()
  const mimeType = evidence.sourceMimeType?.toLowerCase() ?? ''
  return lowerFileName.endsWith('.docx') || mimeType.includes('wordprocessingml')
}

function getEvidenceExtension(fileName: string) {
  const matched = /\.[^.]+$/.exec(fileName)
  return matched?.[0]?.replace('.', '').toUpperCase() ?? 'FILE'
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildParagraphRichText(text: string) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (!lines.length) {
    return '<p></p>'
  }

  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
}

function extractPlainTextFromHtml(html: string) {
  if (typeof document === 'undefined') {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  const container = document.createElement('div')
  container.innerHTML = html
  return container.textContent?.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() ?? ''
}

interface ParagraphRichEditorProps {
  paragraph: CertificateParagraph
  account: string
  certificateId: string
  editable: boolean
  active: boolean
  activeSentenceIndex: number | null
  inlineReferences: Array<{
    key: string
    label: string
    tone: 'evidence' | 'statute' | 'case'
    active?: boolean
    onClick: () => void
  }>
  onActivate: () => void
  onActivateSentence: (sentenceIndex: number, sentenceText: string, userInitiated?: boolean) => void
  onCommit: (patch: Partial<CertificateParagraph>, expected?: { text: string; richText?: string }) => Promise<boolean>
  onRegisterEditor: (editor: Editor | null) => void
  onEditorStateChange: () => void
}

export function ParagraphRichEditor({
  paragraph,
  account,
  certificateId,
  editable,
  active,
  activeSentenceIndex,
  inlineReferences,
  onActivate,
  onActivateSentence,
  onCommit,
  onRegisterEditor,
  onEditorStateChange,
}: ParagraphRichEditorProps) {
  const content = paragraph.richText ?? buildParagraphRichText(paragraph.text)
  const lastCommittedRef = useRef({
    html: content,
    text: paragraph.text,
  })
  const onActivateRef = useRef(onActivate)
  const onActivateSentenceRef = useRef(onActivateSentence)
  const onCommitRef = useRef(onCommit)
  const onRegisterEditorRef = useRef(onRegisterEditor)
  const onEditorStateChangeRef = useRef(onEditorStateChange)
  const key = draftKey(account, certificateId, paragraph.id)
  const pendingDraftRef = useRef<ParagraphDraft | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const savingRef = useRef(false)
  const editedRef = useRef(false)
  const [recoveryDraft, setRecoveryDraft] = useState<ParagraphDraft | null>(null)
  const [draftWarning, setDraftWarning] = useState('')

  const captureDraft = (currentEditor: Editor) => {
    const html = currentEditor.getHTML()
    const text = extractPlainTextFromHtml(html)
    const pending = pendingDraftRef.current
    if (pending?.richText === html && pending.text === text) return
    if (!pending && html === lastCommittedRef.current.html && text === lastCommittedRef.current.text) return
    const draft: ParagraphDraft = {
      key, text, richText: html, baseText: lastCommittedRef.current.text,
      baseRichText: lastCommittedRef.current.html, revision: crypto.randomUUID(),
    }
    pendingDraftRef.current = draft
    void writeDraft(draft).catch(() => {
      reportDiagnostic('draft-storage-failed')
      setDraftWarning('本地草稿保存失败，请检查磁盘空间并及时保存文稿。')
    })
  }
  const commitDraft = async (currentEditor: Editor) => {
    clearTimeout(snapshotTimerRef.current)
    snapshotTimerRef.current = undefined
    captureDraft(currentEditor)
    if (savingRef.current || !pendingDraftRef.current) return
    const draft = pendingDraftRef.current
    savingRef.current = true
    try {
      const saved = await onCommitRef.current(
        { text: draft.text, richText: draft.richText },
        { text: draft.baseText, richText: draft.baseRichText },
      )
      if (saved) {
        lastCommittedRef.current = { html: draft.richText, text: draft.text }
        await removeDraft(draft.key, draft.revision)
        if (pendingDraftRef.current?.revision === draft.revision) {
          pendingDraftRef.current = null
          setDraftWarning('')
        } else if (pendingDraftRef.current) {
          const next = {
            ...pendingDraftRef.current,
            baseText: draft.text,
            baseRichText: draft.richText,
          }
          pendingDraftRef.current = next
          await writeDraft(next)
        }
      } else setDraftWarning('文稿尚未保存完成，本地草稿已保留。')
    } catch {
      setDraftWarning('文稿尚未保存完成，请重试。')
    } finally {
      savingRef.current = false
      if (pendingDraftRef.current && pendingDraftRef.current.revision !== draft.revision && !currentEditor.isDestroyed) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => void commitDraft(currentEditor), 1500)
      }
    }
  }
  const commitDraftRef = useRef(commitDraft)
  const captureDraftRef = useRef(captureDraft)
  useEffect(() => {
    commitDraftRef.current = commitDraft
    captureDraftRef.current = captureDraft
  })

  useEffect(() => {
    onActivateRef.current = onActivate
    onActivateSentenceRef.current = onActivateSentence
    onCommitRef.current = onCommit
    onRegisterEditorRef.current = onRegisterEditor
    onEditorStateChangeRef.current = onEditorStateChange
  }, [onActivate, onActivateSentence, onCommit, onRegisterEditor, onEditorStateChange])

  const handleActivate = useCallback(() => {
    onActivateRef.current()
  }, [])

  const handleEditorStateChange = useCallback(() => {
    onEditorStateChangeRef.current()
  }, [])

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        codeBlock: false,
      }),
      Underline,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      SentenceHighlightExtension,
      LegalReviewExtension,
    ],
    content,
    editorProps: {
      attributes: {
        class: 'tiptap-editor-body',
        spellcheck: 'false',
      },
    },
    onFocus: ({ editor: currentEditor }) => {
      handleActivate()
      const sentence = resolveSentenceSelectionFromEditor(currentEditor)
      if (sentence) {
        onActivateSentenceRef.current(sentence.index, sentence.text)
      }
      handleEditorStateChange()
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      handleActivate()
      const sentence = resolveSentenceSelectionFromEditor(currentEditor)
      if (sentence) {
        onActivateSentenceRef.current(sentence.index, sentence.text)
      }
      handleEditorStateChange()
    },
    onUpdate: ({ editor: currentEditor }) => {
      editedRef.current = true
      // Throttle local snapshots, including during uninterrupted typing.
      if (!snapshotTimerRef.current) snapshotTimerRef.current = setTimeout(() => {
        snapshotTimerRef.current = undefined
        if (!currentEditor.isDestroyed) captureDraftRef.current(currentEditor)
      }, 250)
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        if (!currentEditor.isDestroyed) void commitDraftRef.current(currentEditor)
      }, 1500)
    },
    onBlur: ({ editor: currentEditor }) => {
      clearTimeout(saveTimerRef.current)
      void commitDraftRef.current(currentEditor)
    },
  })

  useEffect(() => {
    if (!editor || !account) return
    let active = true
    const initialContent = lastCommittedRef.current
    void readDraft(key).then(draft => {
      if (!active || !draft || editedRef.current) return
      if (draft.richText === initialContent.html && draft.text === initialContent.text) {
        void removeDraft(key, draft.revision).catch(() => {})
      } else setRecoveryDraft(draft)
    }).catch(() => {
      if (active) setDraftWarning('本地草稿暂不可用，请及时保存文稿。')
    })
    const flush = () => { if (!editor.isDestroyed && editedRef.current) captureDraftRef.current(editor) }
    const retry = () => { if (!editor.isDestroyed && pendingDraftRef.current) void commitDraftRef.current(editor) }
    const handleVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    window.addEventListener('lawverify:service-ready', retry)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      flush()
      clearTimeout(saveTimerRef.current)
      clearTimeout(snapshotTimerRef.current)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('lawverify:service-ready', retry)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [editor, key, account])

  useEffect(() => {
    onRegisterEditorRef.current(editor ?? null)
    return () => {
      onRegisterEditorRef.current(null)
    }
  }, [editor])

  useEffect(() => {
    if (!editor) {
      return
    }

    const nextContent = paragraph.richText ?? buildParagraphRichText(paragraph.text)
    const currentHtml = editor.getHTML()
    if (!editor.isFocused && currentHtml === lastCommittedRef.current.html && currentHtml !== nextContent) {
      editor.commands.setContent(nextContent, { emitUpdate: false })
      lastCommittedRef.current = {
        html: nextContent,
        text: paragraph.text,
      }
    }
  }, [editor, paragraph.richText, paragraph.text])

  useEffect(() => {
    editor?.setEditable(editable && !recoveryDraft, false)
  }, [editor, editable, recoveryDraft])

  useEffect(() => {
    if (!editor) {
      return
    }

    const currentState = sentenceHighlightPluginKey.getState(editor.state) as { activeSentenceIndex: number | null } | undefined
    const nextSentenceIndex = active ? activeSentenceIndex : null
    if ((currentState?.activeSentenceIndex ?? null) === nextSentenceIndex) {
      return
    }

    editor.view.dispatch(editor.state.tr.setMeta(sentenceHighlightPluginKey, {
      activeSentenceIndex: nextSentenceIndex,
    }))
  }, [active, activeSentenceIndex, editor])

  return (
    <div
      className={`tiptap-inline-paragraph ${active ? 'active' : ''}`}
      onClick={(event) => {
        // Keep the editor's sentence selection from being reset by paragraph clicks.
        event.stopPropagation()
        onActivate()
        if (!editor) {
          return
        }
        if (!editor.isFocused) {
          editor.commands.focus()
        }
        const sentence = resolveSentenceSelectionFromEditor(editor)
        if (sentence) {
          onActivateSentence(sentence.index, sentence.text, true)
        }
      }}
    >
      {recoveryDraft ? <div className="draft-recovery" role="alert" onClick={event => event.stopPropagation()}>
        <span>{recoveryDraft.baseText === paragraph.text ? '发现未保存草稿。' : '文稿已有更新，请核对未保存草稿。'}</span>
        <button type="button" onClick={() => {
          if (!editor) return
          editor.commands.setContent(recoveryDraft.richText, { emitUpdate: false })
          editedRef.current = true
          captureDraftRef.current(editor)
          setRecoveryDraft(null)
          void commitDraftRef.current(editor)
        }}>恢复草稿</button>
        <button type="button" onClick={() => {
          void removeDraft(key, recoveryDraft.revision).then(() => setRecoveryDraft(null)).catch(() => setDraftWarning('草稿暂时无法移除。'))
        }}>保留当前文稿</button>
        <details><summary>查看草稿</summary>{recoveryDraft.text}</details>
      </div> : null}
      {draftWarning ? <div className="draft-recovery" role="alert">
        <span>{draftWarning}</span>
        <button type="button" onClick={() => { if (editor) void commitDraftRef.current(editor) }}>重试保存</button>
      </div> : null}
      <EditorContent editor={editor} />
      <LegalReview editor={editor} active={active} account={account} showPanel={false} />
      {inlineReferences.length ? (
        <div className="tiptap-inline-citation-row">
          {inlineReferences.map((chip) => (
            <button
              key={chip.key}
              className={`inline-citation-marker ${chip.tone} ${chip.active ? 'active' : ''}`}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                chip.onClick()
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function WordPreviewSurface({ evidence, sourceUrl }: { evidence: Evidence; sourceUrl?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fallbackPreviewText, setFallbackPreviewText] = useState('')
  const isDocx = isDocxEvidence(evidence)
  const isRtf = evidence.fileName.toLowerCase().endsWith('.rtf')

  useEffect(() => {
    const container = containerRef.current
    const source = sourceUrl

    if (!container || !source || !isDocx) {
      return
    }

    let disposed = false
    const controller = new AbortController()
    setError(null)
    container.replaceChildren()
    container.scrollTop = 0

    void (async () => {
      try {
        const [{ renderAsync }, response] = await Promise.all([
          import('docx-preview'),
          fetchWithWorkspaceAccount(source, { signal: controller.signal }),
        ])
        if (!response.ok) {
          throw new Error('原件暂时无法读取，请重新选择文件或检查本地服务。')
        }
        const arrayBuffer = (await readBoundedSource(response, 20 * 1024 * 1024)).buffer

        if (disposed) {
          return
        }

        // Render off-screen so an obsolete async render cannot overwrite the current file.
        const stagingContainer = document.createElement('div')
        await renderAsync(arrayBuffer, stagingContainer, undefined, {
          className: 'word-preview-document',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
        })
        if (!disposed) {
          container.replaceChildren(...Array.from(stagingContainer.childNodes))
        }
      } catch (renderError) {
        if (!disposed) {
          setError(renderError instanceof Error ? renderError.message : 'Word 预览加载失败')
        }
      }
    })()

    return () => {
      disposed = true
      controller.abort()
      container.replaceChildren()
    }
  }, [evidence.id, isDocx, sourceUrl])

  useEffect(() => {
    setFallbackPreviewText('')
    if (!sourceUrl || isDocx || !isRtf) {
      return
    }

    let disposed = false
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetchWithWorkspaceAccount(sourceUrl, { signal: controller.signal })
        if (!response.ok) {
          throw new Error('原件暂时无法读取')
        }
        const text = new TextDecoder().decode(await readBoundedSource(response, 8 * 1024 * 1024))
        if (!disposed) {
          setFallbackPreviewText(stripRtfControlText(text))
        }
      } catch {
        if (!disposed) {
          setFallbackPreviewText('')
        }
      }
    })()

    return () => {
      disposed = true
      controller.abort()
    }
  }, [evidence.id, isDocx, isRtf, sourceUrl])

  if (!sourceUrl) {
    return <div className="preview-empty">当前 Word 原件尚未写入可预览内容。</div>
  }

  if (!isDocx) {
    const previewParagraphs = (fallbackPreviewText || evidence.ocrText)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    return (
      <div className="document-source">
        <div className="document-source-header">
          <span>{evidence.fileName}</span>
          <span>兼容预览</span>
        </div>
        <div className="document-source-paper">
          <p>当前文件为 Word 兼容格式，浏览器暂不支持版式级结构预览，已展示可读内容。</p>
          {previewParagraphs.length
            ? previewParagraphs.map((line, index) => (
                <p key={`${evidence.id}-word-fallback-${index}`}>{line}</p>
              ))
            : <p>当前文件暂未生成可读预览内容，请使用“打开原件”查看。</p>}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="word-preview-host" ref={containerRef} hidden={Boolean(error)} />
      {error ? (
        <div className="preview-fallback-card">
          <strong>Word 预览暂未生成</strong>
          <p>{error}</p>
        </div>
      ) : null}
    </>
  )
}

function TextOriginalPreview({ sourceUrl, fileName }: { sourceUrl: string; fileName: string }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void fetchWithWorkspaceAccount(sourceUrl, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('原件暂时无法读取')
        return readBoundedSource(response, 8 * 1024 * 1024).then(bytes => new TextDecoder().decode(bytes))
      })
      .then(content => { if (active) setText(content) })
      .catch(() => { if (active) setError('原件暂时无法读取，请重试。') })
    return () => { active = false; controller.abort() }
  }, [sourceUrl])
  return <div className="document-source">
    <div className="document-source-header"><span>{fileName}</span><span>原件全文</span></div>
    <div className="document-source-paper" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {error || text || '正在读取原件...'}
    </div>
  </div>
}

function getDefaultSentenceText(paragraph: CertificateParagraph | null | undefined) {
  const primaryAnchor = getParagraphLinks(paragraph)[0] ?? getParagraphReferences(paragraph)[0]
  return resolveParagraphSentenceSelection(paragraph, primaryAnchor).text
}

function getDefaultSentenceIndex(paragraph: CertificateParagraph | null | undefined) {
  const primaryAnchor = getParagraphLinks(paragraph)[0] ?? getParagraphReferences(paragraph)[0]
  return resolveParagraphSentenceSelection(paragraph, primaryAnchor).index
}

function findSelectedParagraph(workspace: AppState, selection: SelectionState) {
  const certificate = workspace.certificates.find((item) => item.id === selection.selectedCertificateId) ?? null
  return certificate?.paragraphs.find((item) => item.id === selection.activeParagraphId) ?? certificate?.paragraphs[0] ?? null
}

function App() {
  const streamlinedMode = true
  const [appState, setAppState] = useState<AppState | null>(null)
  const [authToken, setAuthToken] = useState(() => sessionStorage.getItem(AUTH_STORAGE_KEY))
  const [cloudAuthToken, setCloudAuthToken] = useState(() => localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY))
  useEffect(() => {
    if (cloudAuthToken) void api.getAnalyticsPreference().then(() => api.recordAppOpen()).catch(() => {})
  }, [cloudAuthToken])
  const [loginAccount, setLoginAccount] = useState(() => sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY) ?? '')
  const [isLoading, setIsLoading] = useState(Boolean(sessionStorage.getItem(AUTH_STORAGE_KEY)))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [autoLinkingCertificateId, setAutoLinkingCertificateId] = useState<string | null>(null)
  const [autoLinkFeedback, setAutoLinkFeedback] = useState<{ tone: 'info' | 'success' | 'loading'; text: string } | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [entryOnboardingStep, setEntryOnboardingStep] = useState<EntryOnboardingStep>('idle')
  const [agentMode, setAgentMode] = useState<'case' | 'document'>('case')
  const [evidenceImportProgress, setEvidenceImportProgress] = useState<EvidenceImportProgress | null>(null)
  const [evidenceImportResult, setEvidenceImportResult] = useState<{ caseId: string; message: string } | null>(null)
  const [directoryImportRetry, setDirectoryImportRetry] = useState<{ caseId: string; directory: CaseDirectoryManifest; message: string } | null>(null)
  const [directoryPreparation, setDirectoryPreparation] = useState<{ caseId: string; completed: number; total: number } | null>(null)
  const [knowledgeUploadProgress, setKnowledgeUploadProgress] = useState<KnowledgeUploadProgress | null>(null)
  const [knowledgeReindexProgressByFileId, setKnowledgeReindexProgressByFileId] = useState<Record<string, KnowledgeReindexProgress>>({})
  const [pendingCaseEvidences, setPendingCaseEvidences] = useState<Evidence[]>([])
  const streamedDirectoryEvidencesRef = useRef<Evidence[]>([])
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [loginForm, setLoginForm] = useState<LoginPayload>({
    account: '',
    password: '',
    loginType: 'password',
  })
  const loginEmailInputRef = useRef<HTMLInputElement | null>(null)
  const [isLoginPasswordVisible, setIsLoginPasswordVisible] = useState(false)
  const [registerForm, setRegisterForm] = useState<DesktopRegisterForm>({
    organizationName: '',
    ownerName: '',
    email: '',
    password: '',
  })
  const registerOrganizationInputRef = useRef<HTMLInputElement | null>(null)
  const [isRegisterPasswordVisible, setIsRegisterPasswordVisible] = useState(false)
  const [caseSearch, setCaseSearch] = useState('')
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [selectedCertificateId, setSelectedCertificateId] = useState<string | null>(null)
  const [activeParagraphId, setActiveParagraphId] = useState<string | null>(null)
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([])
  const [manualPreviewEvidenceId, setManualPreviewEvidenceIdState] = useState<string | null>(null)
  const manualPreviewEvidenceIdRef = useRef<string | null>(null)
  const setManualPreviewEvidenceId = useCallback((evidenceId: string | null) => {
    manualPreviewEvidenceIdRef.current = evidenceId
    setManualPreviewEvidenceIdState(evidenceId)
  }, [])
  const [lockedPreviewEvidenceId, setLockedPreviewEvidenceId] = useState<string | null>(null)
  const [localPreviewSourceMap, setLocalPreviewSourceMap] = useState<Record<string, string>>({})
  const [imageViewerState, setImageViewerState] = useState<ImageViewerState | null>(null)
  const [summarizingEvidenceId, setSummarizingEvidenceId] = useState<string | null>(null)
  const [locatorDraft, setLocatorDraft] = useState('段落 1')
  const [activeSentenceIndex, setActiveSentenceIndex] = useState<number | null>(null)
  const [activeSentenceText, setActiveSentenceText] = useState('')
  const activeSentenceAnchorRef = useRef<{
    certificateId: string | null
    paragraphId: string | null
    sentenceIndex: number | null
    sentenceText: string
  } | null>(null)
  useEffect(() => {
    activeSentenceAnchorRef.current = {
      certificateId: selectedCertificateId,
      paragraphId: activeParagraphId,
      sentenceIndex: activeSentenceIndex,
      sentenceText: activeSentenceText,
    }
  }, [selectedCertificateId, activeParagraphId, activeSentenceIndex, activeSentenceText])
  const [activeTab, setActiveTab] = useState<AppTab>('overview')
  const [caseCenterTab, setCaseCenterTab] = useState<CaseCenterTab>('overview')
  const [previewPanelMode, setPreviewPanelMode] = useState<PreviewPanelMode>('preview')
  const [verifyInsightTab, setVerifyInsightTab] = useState<VerifyInsightTab>('evidence')
  const [ideContentTab, setIdeContentTab] = useState<'document' | 'evidence'>('document')
  const [isIdeAssistantVisible, setIsIdeAssistantVisible] = useState(true)
  const [isIdeAccountOpen, setIsIdeAccountOpen] = useState(false)
  const [ideNavigationRequest, setIdeNavigationRequest] = useState<{ target: IdeNavigationTarget } | null>(null)
  const [activeReferenceIndex, setActiveReferenceIndex] = useState(0)
  const [selectedKnowledgeReferenceId, setSelectedKnowledgeReferenceId] = useState<string | null>(null)
  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>('cases')
  const [knowledgeKeyword, setKnowledgeKeyword] = useState('')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('statutes')
  const [settingsKnowledgeFileKeyword, setSettingsKnowledgeFileKeyword] = useState('')
  const [settingsStatuteKeyword, setSettingsStatuteKeyword] = useState('')
  const [selectedKnowledgeCaseId, setSelectedKnowledgeCaseId] = useState<string | null>(null)
  const [remoteRecommendedKnowledgeCases, setRemoteRecommendedKnowledgeCases] = useState<KnowledgeCase[]>([])
  const [remoteRecommendedKnowledgeStatutes, setRemoteRecommendedKnowledgeStatutes] = useState<KnowledgeStatuteDocument[]>([])
  const [selectedStatuteId, setSelectedStatuteId] = useState<string | null>(null)
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null)
  const [settingsSelectedKnowledgeFileId, setSettingsSelectedKnowledgeFileId] = useState<string | null>(null)
  const [settingsSelectedStatuteId, setSettingsSelectedStatuteId] = useState<string | null>(null)
  const [settingsSelectedArticleId, setSettingsSelectedArticleId] = useState<string | null>(null)
  const [isKnowledgeLibraryDialogOpen, setIsKnowledgeLibraryDialogOpen] = useState(false)
  const [editorToolbarVersion, setEditorToolbarVersion] = useState(0)
  const [isStreamlinedSidebarCollapsed, setIsStreamlinedSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    return window.localStorage.getItem(STREAMLINED_SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  })
  const [streamlinedSidebarWidth, setStreamlinedSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_STREAMLINED_SIDEBAR_WIDTH
    }

    const storedValue = window.localStorage.getItem(STREAMLINED_SIDEBAR_WIDTH_STORAGE_KEY)
    const storedWidth = storedValue === null ? DEFAULT_STREAMLINED_SIDEBAR_WIDTH : Number(storedValue)
    return Number.isFinite(storedWidth)
      ? clampStreamlinedSidebarWidth(storedWidth)
      : DEFAULT_STREAMLINED_SIDEBAR_WIDTH
  })
  const [isResizingStreamlinedSidebar, setIsResizingStreamlinedSidebar] = useState(false)
  const [insightPanelWidth, setInsightPanelWidth] = useState(DEFAULT_INSIGHT_PANEL_WIDTH)
  const [isResizingWorkbench, setIsResizingWorkbench] = useState(false)
  const [knowledgeFilesSidebarWidth, setKnowledgeFilesSidebarWidth] = useState(DEFAULT_KNOWLEDGE_FILES_SIDEBAR_WIDTH)
  const [isResizingKnowledgeFilesSidebar, setIsResizingKnowledgeFilesSidebar] = useState(false)
  const [caseDialogState, setCaseDialogState] = useState<CaseDialogState | null>(null)
  const [rechargeDialogState, setRechargeDialogState] = useState<RechargeDialogState | null>(null)
  const [feedbackDialogState, setFeedbackDialogState] = useState<FeedbackDialogState | null>(null)
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>({
    status: 'idle',
    latestRelease: null,
    progress: null,
    message: '',
  })
  const [isAgentWindowOpen, setIsAgentWindowOpen] = useState(false)
  const [agentDockPosition, setAgentDockPosition] = useState(() => ({
    x: AGENT_DOCK_MARGIN,
    y: AGENT_DOCK_MARGIN,
  }))
  const [isDraggingAgentDock, setIsDraggingAgentDock] = useState(false)
  const agentPromptRef = useRef('')
  const agentPromptInputRef = useRef<AgentPromptInputHandle | null>(null)
  function setAgentPrompt(value: string) {
    agentPromptRef.current = value
    agentPromptInputRef.current?.setValue(value)
  }
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([])
  const [streamingCertificatePreview, setStreamingCertificatePreview] = useState<StreamingCertificatePreview | null>(null)
  const [pointPolicyMap, setPointPolicyMap] = useState<Record<ChargeablePointAction, number>>(DEFAULT_POINT_POLICY_MAP)
  const folderUploadRef = useRef<HTMLInputElement | null>(null)
  const knowledgeFolderUploadRef = useRef<HTMLInputElement | null>(null)
  const certificateUploadRef = useRef<HTMLInputElement | null>(null)
  const certificateUploadInputId = useId()
  const knowledgeFileUploadInputId = useId()
  const streamlinedShellRef = useRef<HTMLDivElement | null>(null)
  const streamlinedSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const settingsKnowledgeFilesSectionRef = useRef<HTMLElement | null>(null)
  const settingsStatutesSectionRef = useRef<HTMLElement | null>(null)
  const evidenceColumnRef = useRef<HTMLDivElement | null>(null)
  const workbenchRef = useRef<HTMLElement | null>(null)
  const workbenchResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const knowledgeLibraryBodyRef = useRef<HTMLDivElement | null>(null)
  const knowledgeFilesSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const knowledgeUploadProgressTimerRefs = useRef<number[]>([])
  const knowledgeUploadClearTimerRef = useRef<number | null>(null)
  const knowledgeReindexTimerRefs = useRef<Record<string, number[]>>({})
  const knowledgeReindexClearTimerRefs = useRef<Record<string, number>>({})
  const agentDockRef = useRef<HTMLDivElement | null>(null)
  const agentDockDragRef = useRef<{
    offsetX: number
    offsetY: number
    startX: number
    startY: number
  } | null>(null)
  const agentDockClickGuardRef = useRef(false)
  const agentDockInitializedRef = useRef(false)
  const agentDockExpandedPositionRef = useRef<{ x: number; y: number } | null>(null)
  const paragraphEditorsRef = useRef<Record<string, Editor | null>>({})
  const documentTaskQueueRef = useRef(createDocumentTaskQueue())
  const documentAnalysisRunningRef = useRef(false)
  const localPreviewSourceMapRef = useRef<Record<string, string>>({})
  const localWorkspaceRef = useRef<AppState | null>(null)
  const cloudPointsSyncRef = useRef<CloudPointsSyncState | null>(null)
  const cloudPointsRevisionRef = useRef(0)
  const cloudAccountProfileRef = useRef<CloudAccountSessionProfile | null>(null)
  const hasCheckedAppUpdateOnLaunchRef = useRef(false)
  const isDesktopClient = window.lawVerifyDesktop?.channel === 'electron'

  const checkForAppUpdate = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!isDesktopClient) {
      return
    }

    if (appUpdateState.status === 'downloading') {
      return
    }

    setAppUpdateState((current) => ({
      ...current,
      status: 'checking',
      progress: null,
      message: options.silent ? current.message : '正在检查桌面端新版本…',
    }))

    try {
      const latestRelease = await api.getLatestPublicRelease()
      const hasNewerVersion = latestRelease && compareAppVersions(__APP_VERSION__, latestRelease.version) < 0

      setAppUpdateState({
        status: hasNewerVersion ? 'available' : 'up-to-date',
        latestRelease,
        progress: null,
        message: hasNewerVersion
          ? `发现新版本 v${latestRelease.version}，可直接更新。`
          : options.silent ? '' : `当前已是最新版本 v${__APP_VERSION__}。`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '检查更新失败，请稍后重试。'
      setAppUpdateState((current) => ({
        ...current,
        status: 'error',
        progress: null,
        message,
      }))
    }
  }, [appUpdateState.status, isDesktopClient])

  const handleStartAppUpdate = useCallback(async () => {
    const latestRelease = appUpdateState.latestRelease
    if (!latestRelease) {
      return
    }

    if (window.lawVerifyDesktop?.startAppUpdate) {
      try {
        await window.lawVerifyDesktop.startAppUpdate({
          version: latestRelease.version,
          downloadUrl: latestRelease.downloadUrl,
          sha256: latestRelease.sha256,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : '更新失败，请稍后重试。'
        setAppUpdateState((current) => ({
          ...current,
          status: 'error',
          progress: null,
          message,
        }))
      }
      return
    }

    await openExternalUrl(latestRelease.downloadUrl)
  }, [appUpdateState.latestRelease])

  useEffect(() => {
    if (!isDesktopClient || !window.lawVerifyDesktop?.onAppUpdateStatus) {
      return
    }

    return window.lawVerifyDesktop.onAppUpdateStatus((payload) => {
      setAppUpdateState((current) => ({
        ...current,
        status: payload.status === 'error' ? 'error' : payload.status,
        progress: typeof payload.progress === 'number' ? payload.progress : current.progress,
        message: payload.message ?? current.message,
      }))
    })
  }, [isDesktopClient])

  useEffect(() => {
    if (!isDesktopClient) {
      return
    }

    if (hasCheckedAppUpdateOnLaunchRef.current) {
      return
    }

    hasCheckedAppUpdateOnLaunchRef.current = true
    void checkForAppUpdate({ silent: true })
  }, [checkForAppUpdate, isDesktopClient])

  useEffect(() => {
    if (authToken || isSubmitting) {
      return
    }

    const targetInput = authMode === 'login'
      ? loginEmailInputRef.current
      : registerOrganizationInputRef.current

    if (!targetInput) {
      return
    }

    const timerId = window.setTimeout(() => {
      targetInput.focus({ preventScroll: true })
      targetInput.select()
    }, 50)

    return () => {
      window.clearTimeout(timerId)
    }
  }, [authMode, authToken, isSubmitting])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(
      STREAMLINED_SIDEBAR_COLLAPSED_STORAGE_KEY,
      isStreamlinedSidebarCollapsed ? '1' : '0',
    )
  }, [isStreamlinedSidebarCollapsed])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(
      STREAMLINED_SIDEBAR_WIDTH_STORAGE_KEY,
      String(Math.round(streamlinedSidebarWidth)),
    )
  }, [streamlinedSidebarWidth])

  useEffect(() => {
    const syncStreamlinedSidebarWidth = () => {
      setStreamlinedSidebarWidth((current) => {
        const containerWidth = streamlinedShellRef.current?.getBoundingClientRect().width ?? 0
        return clampStreamlinedSidebarWidth(current, containerWidth || undefined)
      })
    }

    syncStreamlinedSidebarWidth()
    window.addEventListener('resize', syncStreamlinedSidebarWidth)
    return () => {
      window.removeEventListener('resize', syncStreamlinedSidebarWidth)
    }
  }, [])

  const replaceLocalPreviewSourceMap = (nextEntries: Record<string, string>) => {
    setLocalPreviewSourceMap((current) => {
      const next = { ...current }

      for (const [key, url] of Object.entries(nextEntries)) {
        if (next[key] && next[key] !== url) {
          URL.revokeObjectURL(next[key])
        }
        next[key] = url
      }

      return next
    })
  }

  const clearLocalPreviewSourceMap = () => {
    setLocalPreviewSourceMap((current) => {
      Object.values(current).forEach((url) => URL.revokeObjectURL(url))
      return {}
    })
  }

  const clearKnowledgeUploadTimers = useCallback(() => {
    knowledgeUploadProgressTimerRefs.current.forEach((timerId) => window.clearTimeout(timerId))
    knowledgeUploadProgressTimerRefs.current = []

    if (knowledgeUploadClearTimerRef.current !== null) {
      window.clearTimeout(knowledgeUploadClearTimerRef.current)
      knowledgeUploadClearTimerRef.current = null
    }
  }, [])

  const queueKnowledgeUploadStage = useCallback((stage: KnowledgeUploadProgress['stage'], delayMs: number, message: string) => {
    if (typeof window === 'undefined') {
      return
    }

    const timerId = window.setTimeout(() => {
      setKnowledgeUploadProgress((current) => {
        if (!current || current.stage === 'complete' || current.stage === 'failed') {
          return current
        }

        return {
          ...current,
          stage,
          message,
        }
      })
      knowledgeUploadProgressTimerRefs.current = knowledgeUploadProgressTimerRefs.current.filter((item) => item !== timerId)
    }, delayMs)
    knowledgeUploadProgressTimerRefs.current.push(timerId)
  }, [])

  const scheduleKnowledgeUploadClear = useCallback((delayMs = 3600) => {
    if (typeof window === 'undefined') {
      return
    }

    if (knowledgeUploadClearTimerRef.current !== null) {
      window.clearTimeout(knowledgeUploadClearTimerRef.current)
    }

    knowledgeUploadClearTimerRef.current = window.setTimeout(() => {
      setKnowledgeUploadProgress((current) => {
        if (!current || (current.stage !== 'complete' && current.stage !== 'failed')) {
          return current
        }

        return null
      })
      knowledgeUploadClearTimerRef.current = null
    }, delayMs)
  }, [])

  useEffect(() => () => {
    clearKnowledgeUploadTimers()
  }, [clearKnowledgeUploadTimers])

  const clearKnowledgeReindexTimers = useCallback((fileId?: string) => {
    const timerMap = knowledgeReindexTimerRefs.current
    const clearTimerMap = knowledgeReindexClearTimerRefs.current

    if (fileId) {
      ;(timerMap[fileId] ?? []).forEach((timerId) => window.clearTimeout(timerId))
      delete timerMap[fileId]

      if (clearTimerMap[fileId] !== undefined) {
        window.clearTimeout(clearTimerMap[fileId])
        delete clearTimerMap[fileId]
      }
      return
    }

    Object.values(timerMap).forEach((timerIds) => {
      timerIds.forEach((timerId) => window.clearTimeout(timerId))
    })
    knowledgeReindexTimerRefs.current = {}

    Object.values(clearTimerMap).forEach((timerId) => window.clearTimeout(timerId))
    knowledgeReindexClearTimerRefs.current = {}
  }, [])

  const queueKnowledgeReindexStage = useCallback((
    fileId: string,
    stage: KnowledgeReindexProgress['stage'],
    delayMs: number,
    message: string,
  ) => {
    if (typeof window === 'undefined') {
      return
    }

    const timerId = window.setTimeout(() => {
      setKnowledgeReindexProgressByFileId((current) => {
        const target = current[fileId]
        if (!target || target.stage === 'complete' || target.stage === 'failed') {
          return current
        }

        return {
          ...current,
          [fileId]: {
            ...target,
            stage,
            message,
          },
        }
      })
      const nextTimers = [...(knowledgeReindexTimerRefs.current[fileId] ?? [])].filter((item) => item !== timerId)
      if (nextTimers.length) {
        knowledgeReindexTimerRefs.current[fileId] = nextTimers
      } else {
        delete knowledgeReindexTimerRefs.current[fileId]
      }
    }, delayMs)
    knowledgeReindexTimerRefs.current[fileId] = [...(knowledgeReindexTimerRefs.current[fileId] ?? []), timerId]
  }, [])

  const scheduleKnowledgeReindexClear = useCallback((fileId: string, delayMs = 3600) => {
    if (typeof window === 'undefined') {
      return
    }

    if (knowledgeReindexClearTimerRefs.current[fileId] !== undefined) {
      window.clearTimeout(knowledgeReindexClearTimerRefs.current[fileId])
    }

    knowledgeReindexClearTimerRefs.current[fileId] = window.setTimeout(() => {
      setKnowledgeReindexProgressByFileId((current) => {
        const target = current[fileId]
        if (!target || (target.stage !== 'complete' && target.stage !== 'failed')) {
          return current
        }

        const next = { ...current }
        delete next[fileId]
        return next
      })
      delete knowledgeReindexClearTimerRefs.current[fileId]
    }, delayMs)
  }, [])

  useEffect(() => () => {
    clearKnowledgeReindexTimers()
  }, [clearKnowledgeReindexTimers])

  const persistCloudAuthToken = useCallback((token: string | null) => {
    cloudPointsRevisionRef.current += 1
    if (token?.trim()) {
      localStorage.setItem(CLOUD_TOKEN_STORAGE_KEY, token)
      setCloudAuthToken(token)
      return
    }

    localStorage.removeItem(CLOUD_TOKEN_STORAGE_KEY)
    setCloudAuthToken(null)
  }, [])

  const applyCloudPointSyncState = useCallback((nextSyncState: CloudPointsSyncState | null) => {
    cloudPointsRevisionRef.current += 1
    cloudPointsSyncRef.current = nextSyncState
    if (localWorkspaceRef.current) {
      setAppState(mergeWorkspaceWithCloudPoints(localWorkspaceRef.current, nextSyncState))
    }
  }, [])

  const updateCloudPointLedgerPreview = useCallback((entry: CloudLedgerEntrySnapshot, pointsBalance: number) => {
    const existing = cloudPointsSyncRef.current
    const nextLogs = [
      mapCloudLedgerEntryToPointLog(entry),
      ...(existing?.cloudPointLogs ?? []).filter((item) => item.id !== entry.id),
    ]

    applyCloudPointSyncState({
      cloudPointsBalance: pointsBalance,
      cloudPointLogs: nextLogs,
    })
  }, [applyCloudPointSyncState])

  const applyWorkspace = (
    workspace: AppState,
    nextSelection: Partial<SelectionState> = {},
    options: {
      preserveManualPreview?: boolean
    } = {},
  ) => {
    const normalizedWorkspace = enrichWorkspaceWithCloudProfile(
      normalizeWorkspaceState(workspace),
      cloudAccountProfileRef.current,
    )
    localWorkspaceRef.current = normalizedWorkspace
    const displayWorkspace = mergeWorkspaceWithCloudPoints(normalizedWorkspace, cloudPointsSyncRef.current)
    const selection = deriveSelection(displayWorkspace, {
      selectedCaseId,
      selectedCertificateId,
      activeParagraphId,
      selectedEvidenceIds,
      locatorDraft,
      ...nextSelection,
    })
    const currentManualPreviewEvidenceId = manualPreviewEvidenceIdRef.current
    const streamedPreview = streamedDirectoryEvidencesRef.current.find(e => e.id === currentManualPreviewEvidenceId)
    const savedPreview = streamedPreview && displayWorkspace.evidences.find(e =>
      e.caseId === streamedPreview.caseId && e.relativePath === streamedPreview.relativePath,
    )
    const nextManualPreviewEvidenceId = savedPreview?.id ?? currentManualPreviewEvidenceId
    const shouldPreserveManualPreview = options.preserveManualPreview !== false
      && Boolean(currentManualPreviewEvidenceId)
      && (Boolean(streamedPreview?.caseId === selection.selectedCaseId) || displayWorkspace.evidences.some(
        (item) => item.id === nextManualPreviewEvidenceId && item.caseId === selection.selectedCaseId,
      ))
    const sentenceAnchor = activeSentenceAnchorRef.current
    const nextParagraph = findSelectedParagraph(displayWorkspace, selection)
    const shouldPreserveSentence = sentenceAnchor
      && sentenceAnchor.certificateId === selection.selectedCertificateId
      && sentenceAnchor.paragraphId === nextParagraph?.id
    const nextSentence = resolveParagraphSentenceSelection(
      nextParagraph,
      shouldPreserveSentence ? {
        sentenceIndex: sentenceAnchor.sentenceIndex ?? undefined,
        sentenceText: sentenceAnchor.sentenceText,
      } : getParagraphLinks(nextParagraph)[0],
    )

    setAppState(displayWorkspace)
    setSelectedCaseId(selection.selectedCaseId)
    setSelectedCertificateId(selection.selectedCertificateId)
    setActiveParagraphId(selection.activeParagraphId)
    setSelectedEvidenceIds(selection.selectedEvidenceIds)
    setManualPreviewEvidenceId(shouldPreserveManualPreview ? nextManualPreviewEvidenceId : null)
    setImageViewerState(null)
    setLocatorDraft(selection.locatorDraft)
    setActiveSentenceIndex(nextSentence.index)
    setActiveSentenceText(nextSentence.text)
  }

  const applyWorkspaceWithKnowledgeFiles = useCallback((
    workspace: AppState,
    files: KnowledgeFileRecord[],
    nextSelection: Partial<SelectionState> = {},
  ) => {
    if (!files.length) {
      applyWorkspace(workspace, nextSelection)
      return
    }

    const normalizedWorkspace = normalizeWorkspaceState(workspace)
    const nextKnowledgeFiles = [...(normalizedWorkspace.knowledgeFiles ?? [])]

    for (const file of files) {
      const existingIndex = nextKnowledgeFiles.findIndex((item) => item.id === file.id || item.fileName === file.fileName)

      if (existingIndex >= 0) {
        nextKnowledgeFiles[existingIndex] = {
          ...nextKnowledgeFiles[existingIndex],
          ...file,
        }
      } else {
        nextKnowledgeFiles.unshift(file)
      }
    }

    applyWorkspace({
      ...normalizedWorkspace,
      knowledgeFiles: nextKnowledgeFiles,
    }, nextSelection)
  }, [applyWorkspace])

    async function bindWorkspaceToCloudProfile(profile: CloudAccountSessionProfile) {
      const result = await api.bindWorkspaceCloudAccount({
        email: profile.email,
        name: profile.name,
        organization: profile.organization,
        role: profile.role,
      })

      applyWorkspace(result.workspace)
      return result.workspace
    }

  const completeDesktopAuthSession = useCallback(async (
    account: string,
    profile: CloudAccountSessionProfile,
  ) => {
    const normalizedAccount = account.trim().toLowerCase()
    const { token, workspace } = await api.createCloudWorkspaceSession({
      email: normalizedAccount,
      name: profile.name,
      organization: profile.organization,
      role: profile.role,
    })

    sessionStorage.setItem(AUTH_STORAGE_KEY, token)
    sessionStorage.setItem(LOGIN_ACCOUNT_STORAGE_KEY, normalizedAccount)
    localStorage.removeItem(AUTH_STORAGE_KEY)
    localStorage.removeItem('lawverify-auth-token')
    setAuthToken(token)
    setLoginAccount(normalizedAccount)
    setErrorMessage('')
    applyWorkspace(workspace)
  }, [])

  useEffect(() => {
    localPreviewSourceMapRef.current = localPreviewSourceMap
  }, [localPreviewSourceMap])

  useEffect(() => {
    return () => {
      Object.values(localPreviewSourceMapRef.current).forEach((url) => URL.revokeObjectURL(url))
    }
  }, [])

  useEffect(() => {
    localStorage.removeItem(AUTH_STORAGE_KEY)
    localStorage.removeItem('lawverify-auth-token')
  }, [])

  useEffect(() => {
    if (!cloudAuthToken) {
      cloudAccountProfileRef.current = null
      setPointPolicyMap(DEFAULT_POINT_POLICY_MAP)
      return
    }

    let active = true

    void api.getCloudProfile()
      .then((profile) => {
        if (!active) {
          return
        }

          const nextProfile: CloudAccountSessionProfile = {
          email: profile.user.email,
          name: profile.user.name,
            organization: profile.organization.name,
            role: profile.organization.role,
        }
          cloudAccountProfileRef.current = nextProfile

          if (authToken) {
            void bindWorkspaceToCloudProfile(nextProfile).catch(() => {
              // 账号中心已登录时，桌面端仍然优先保持可用，绑定失败不打断当前会话。
            })
          }

        if (localWorkspaceRef.current) {
          applyWorkspace(localWorkspaceRef.current)
        }
      })
      .catch((error) => {
        if (!active) {
          return
        }

        if (isCloudAuthApiError(error) && authToken) {
          handleCloudSessionExpired(error.message)
          return
        }

        cloudAccountProfileRef.current = null
        persistCloudAuthToken(null)
      })

    void api.getCloudPointPolicies()
      .then((payload) => {
        if (!active) {
          return
        }

        const nextMap = { ...DEFAULT_POINT_POLICY_MAP }
        payload.items.forEach((item) => {
          if (item.actionType === 'evidence_summary' || item.actionType === 'pleading_full') {
            nextMap[item.actionType] = item.pointsPerUnit
          }
        })
        setPointPolicyMap(nextMap)
      })
      .catch(() => {
        if (active) {
          setPointPolicyMap(DEFAULT_POINT_POLICY_MAP)
        }
      })

    return () => {
      active = false
    }
    }, [authToken, cloudAuthToken, persistCloudAuthToken])

  const syncCloudPoints = useCallback(async () => {
    const workspace = localWorkspaceRef.current
    if (!authToken || !workspace) {
      return
    }

    const desktopEmail = workspace.user.email?.trim()
    if (!cloudAuthToken && !desktopEmail) {
      return
    }

    try {
      const revision = cloudPointsRevisionRef.current
      const syncPayload = cloudAuthToken
        ? await Promise.all([
          api.getCloudAccountSummary(),
          api.getCloudPointLedger(),
        ]).then(([account, ledger]) => ({
          account,
          ledger,
        }))
        : await api.getCloudDesktopSync(desktopEmail)

      if (revision !== cloudPointsRevisionRef.current) return
      const nextSyncState: CloudPointsSyncState = {
        cloudPointsBalance: syncPayload.account.pointsBalance,
        cloudPointLogs: syncPayload.ledger.items.map((item) => mapCloudLedgerEntryToPointLog({
          id: item.id,
          createdAt: item.createdAt,
          description: item.description,
          delta: item.delta,
          balanceAfter: item.balanceAfter,
          entryType: item.entryType,
          actionType: item.actionType,
          operationKey: item.operationKey,
        })),
      }

      applyCloudPointSyncState(nextSyncState)
    } catch (error) {
      if (isCloudAuthApiError(error)) {
        handleCloudSessionExpired(error.message)
        return
      }

      // 桌面端在云端不可达时仍应继续工作，因此同步失败时保持本地积分视图。
    }
  }, [applyCloudPointSyncState, authToken, cloudAuthToken])

  useEffect(() => {
    if (!rechargeDialogState?.activeOrder || rechargeDialogState.activeOrder.status !== 'pending') {
      return
    }

    const orderId = rechargeDialogState.activeOrder.id
    let active = true
    let running = false
    const refresh = async () => {
      if (!active || running || document.visibilityState === 'hidden') return
      running = true
      try { await refreshRechargeOrder(orderId, true) } finally { running = false }
    }
    const timer = window.setInterval(() => void refresh(), 3000)
    void refresh()

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [rechargeDialogState?.activeOrder?.id, rechargeDialogState?.activeOrder?.status])

  useEffect(() => {
    if (!authToken) {
      return
    }

    let active = true
    let running = false
    const syncNow = async () => {
      if (!active || running || document.visibilityState === 'hidden') return
      running = true
      try { await syncCloudPoints() } finally { running = false }
    }

    syncNow()
    const timer = window.setInterval(syncNow, 15000)
    const handleFocus = () => {
      syncNow()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncNow()
      }
    }

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [authToken, syncCloudPoints])

  useEffect(() => {
    const syncWorkbenchWidth = () => {
      setInsightPanelWidth((current) => {
        const containerWidth = workbenchRef.current?.getBoundingClientRect().width ?? 0
        if (!containerWidth) {
          return current
        }

        const maxWidth = Math.max(
          MIN_INSIGHT_PANEL_WIDTH,
          containerWidth - MIN_DOCUMENT_PANEL_WIDTH - WORKBENCH_RESIZER_WIDTH,
        )

        return Math.min(Math.max(current, MIN_INSIGHT_PANEL_WIDTH), maxWidth)
      })
    }

    syncWorkbenchWidth()
    window.addEventListener('resize', syncWorkbenchWidth)
    return () => {
      window.removeEventListener('resize', syncWorkbenchWidth)
    }
  }, [])

  useEffect(() => {
    const syncKnowledgeFilesSidebarWidth = () => {
      setKnowledgeFilesSidebarWidth((current) => {
        const containerWidth = knowledgeLibraryBodyRef.current?.getBoundingClientRect().width ?? 0
        if (!containerWidth || window.innerWidth <= 960) {
          return current
        }

        const maxWidth = Math.min(
          MAX_KNOWLEDGE_FILES_SIDEBAR_WIDTH,
          Math.max(
            MIN_KNOWLEDGE_FILES_SIDEBAR_WIDTH,
            containerWidth - 360 - KNOWLEDGE_FILES_SIDEBAR_RESIZER_WIDTH,
          ),
        )

        return Math.min(Math.max(current, MIN_KNOWLEDGE_FILES_SIDEBAR_WIDTH), maxWidth)
      })
    }

    syncKnowledgeFilesSidebarWidth()
    window.addEventListener('resize', syncKnowledgeFilesSidebarWidth)
    return () => {
      window.removeEventListener('resize', syncKnowledgeFilesSidebarWidth)
    }
  }, [])

  useEffect(() => {
    if (!isResizingWorkbench) {
      return
    }

    const updateWorkbenchWidth = (clientX: number) => {
      const dragState = workbenchResizeRef.current
      const containerWidth = workbenchRef.current?.getBoundingClientRect().width ?? 0

      if (!dragState || !containerWidth) {
        return
      }

      const nextWidth = dragState.startWidth - (clientX - dragState.startX)
      const maxWidth = Math.max(
        MIN_INSIGHT_PANEL_WIDTH,
        containerWidth - MIN_DOCUMENT_PANEL_WIDTH - WORKBENCH_RESIZER_WIDTH,
      )
      setInsightPanelWidth(Math.min(Math.max(nextWidth, MIN_INSIGHT_PANEL_WIDTH), maxWidth))
    }

    const stopWorkbenchResize = () => {
      workbenchResizeRef.current = null
      setIsResizingWorkbench(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    const handlePointerMove = (event: PointerEvent) => {
      updateWorkbenchWidth(event.clientX)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopWorkbenchResize)
    window.addEventListener('pointercancel', stopWorkbenchResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopWorkbenchResize)
      window.removeEventListener('pointercancel', stopWorkbenchResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizingWorkbench])

  useEffect(() => {
    if (!isResizingStreamlinedSidebar) {
      return
    }

    const updateStreamlinedSidebarWidth = (clientX: number) => {
      const dragState = streamlinedSidebarResizeRef.current
      const containerWidth = streamlinedShellRef.current?.getBoundingClientRect().width ?? 0

      if (!dragState || !containerWidth) {
        return
      }

      const nextRawWidth = dragState.startWidth + (clientX - dragState.startX)
      if (nextRawWidth <= STREAMLINED_SIDEBAR_COLLAPSE_THRESHOLD) {
        setIsStreamlinedSidebarCollapsed(true)
        return
      }

      setIsStreamlinedSidebarCollapsed(false)
      setStreamlinedSidebarWidth(clampStreamlinedSidebarWidth(nextRawWidth, containerWidth))
    }

    const stopStreamlinedSidebarResize = () => {
      streamlinedSidebarResizeRef.current = null
      setIsResizingStreamlinedSidebar(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    const handlePointerMove = (event: PointerEvent) => {
      updateStreamlinedSidebarWidth(event.clientX)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopStreamlinedSidebarResize)
    window.addEventListener('pointercancel', stopStreamlinedSidebarResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopStreamlinedSidebarResize)
      window.removeEventListener('pointercancel', stopStreamlinedSidebarResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizingStreamlinedSidebar])

  useEffect(() => {
    if (!isResizingKnowledgeFilesSidebar) {
      return
    }

    const updateKnowledgeFilesSidebarWidth = (clientX: number) => {
      const dragState = knowledgeFilesSidebarResizeRef.current
      const containerWidth = knowledgeLibraryBodyRef.current?.getBoundingClientRect().width ?? 0

      if (!dragState || !containerWidth) {
        return
      }

      const nextWidth = dragState.startWidth + (clientX - dragState.startX)
      const maxWidth = Math.min(
        MAX_KNOWLEDGE_FILES_SIDEBAR_WIDTH,
        Math.max(
          MIN_KNOWLEDGE_FILES_SIDEBAR_WIDTH,
          containerWidth - 360 - KNOWLEDGE_FILES_SIDEBAR_RESIZER_WIDTH,
        ),
      )

      setKnowledgeFilesSidebarWidth(Math.min(Math.max(nextWidth, MIN_KNOWLEDGE_FILES_SIDEBAR_WIDTH), maxWidth))
    }

    const stopKnowledgeFilesSidebarResize = () => {
      knowledgeFilesSidebarResizeRef.current = null
      setIsResizingKnowledgeFilesSidebar(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    const handlePointerMove = (event: PointerEvent) => {
      updateKnowledgeFilesSidebarWidth(event.clientX)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopKnowledgeFilesSidebarResize)
    window.addEventListener('pointercancel', stopKnowledgeFilesSidebarResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopKnowledgeFilesSidebarResize)
      window.removeEventListener('pointercancel', stopKnowledgeFilesSidebarResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizingKnowledgeFilesSidebar])

  useEffect(() => {
    const syncAgentDockPosition = () => {
      const dock = agentDockRef.current
      const width = dock?.offsetWidth ?? (isAgentWindowOpen ? AGENT_DOCK_EXPANDED_WIDTH : AGENT_DOCK_COLLAPSED_SIZE)
      const height = dock?.offsetHeight ?? (isAgentWindowOpen ? AGENT_DOCK_EXPANDED_HEIGHT : AGENT_DOCK_COLLAPSED_SIZE)

      setAgentDockPosition((current) => {
        if (!agentDockInitializedRef.current) {
          agentDockInitializedRef.current = true
          return getDefaultAgentDockPosition(width, height)
        }

        return clampAgentDockPosition(current, width, height)
      })
    }

    const frameId = window.requestAnimationFrame(syncAgentDockPosition)
    const observer = new ResizeObserver(syncAgentDockPosition)
    if (agentDockRef.current) {
      observer.observe(agentDockRef.current)
    }
    window.addEventListener('resize', syncAgentDockPosition)
    return () => {
      window.cancelAnimationFrame(frameId)
      observer.disconnect()
      window.removeEventListener('resize', syncAgentDockPosition)
    }
  }, [isAgentWindowOpen])

  useEffect(() => {
    if (!isDraggingAgentDock) {
      return
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = agentDockDragRef.current
      const dock = agentDockRef.current
      if (!dragState || !dock) {
        return
      }

      if (Math.abs(event.clientX - dragState.startX) > 4 || Math.abs(event.clientY - dragState.startY) > 4) {
        agentDockClickGuardRef.current = true
      }

      setAgentDockPosition(
        clampAgentDockPosition(
          {
            x: event.clientX - dragState.offsetX,
            y: event.clientY - dragState.offsetY,
          },
          dock.offsetWidth,
          dock.offsetHeight,
        ),
      )
    }

    const handlePointerUp = () => {
      setIsDraggingAgentDock(false)
      agentDockDragRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [isDraggingAgentDock])

  useEffect(() => {
    if (!authToken) {
      return
    }

    let active = true
    api
      .getWorkspace()
      .then(({ workspace }) => {
        if (!active) {
          return
        }
        applyWorkspace(workspace)
        void syncCloudPoints()
        setErrorMessage('')
      })
      .catch((error: Error) => {
        if (!active) {
          return
        }
        setErrorMessage(error.message)
      })
      .finally(() => {
        if (active) {
          setIsLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [authToken, syncCloudPoints])

  const hasBackgroundEvidenceProcessing = Boolean(
    appState?.evidences.some((item) => item.summaryStatus === 'processing')
    || appState?.cases.some(c => c.agent?.autoAnalyze !== false && ['queued', 'processing'].includes(c.agent?.task?.status ?? '')),
  )

  const backgroundWorkspaceHandler = useRef<(workspace: AppState) => void>(() => {})
  backgroundWorkspaceHandler.current = workspace => applyWorkspace(workspace, {}, { preserveManualPreview: true })
  useEffect(() => {
    if (!authToken || !hasBackgroundEvidenceProcessing) {
      return
    }

    let active = true
    let running = false
    let dirty = false
    const controller = new AbortController()
    const syncWorkspace = async () => {
      if (!active || document.visibilityState === 'hidden') return
      if (running) { dirty = true; return }
      running = true
      try {
        const { workspace } = await api.getWorkspace(controller.signal)
        if (!active) {
          return
        }

        backgroundWorkspaceHandler.current(workspace)
      } catch {
        // 后台处理中时静默同步，避免打断当前操作。
      } finally {
        running = false
        if (dirty && active) { dirty = false; void syncWorkspace() }
      }
    }

    void syncWorkspace()
    const timer = window.setInterval(() => {
      void syncWorkspace()
    }, 60000)
    const unwatch = watchWorkspace(() => void syncWorkspace())
    const handleFocus = () => {
      void syncWorkspace()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncWorkspace()
      }
    }

    window.addEventListener('focus', handleFocus)
    window.addEventListener('lawverify:service-ready', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      active = false
      controller.abort()
      unwatch()
      window.clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('lawverify:service-ready', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    authToken,
    hasBackgroundEvidenceProcessing,
  ])

  useEffect(() => {
    if (entryOnboardingStep !== 'create-case' || !appState) {
      return
    }

    if (appState.cases.length > 0) {
      setEntryOnboardingStep('idle')
      return
    }

    setActiveTab('workspace')
    setCaseCenterTab('overview')
    setCaseDialogState((current) => current ?? {
      mode: 'create',
      title: '新建案件',
      confirmLabel: '创建案件',
      value: '',
    })
  }, [appState, entryOnboardingStep])

  useEffect(() => {
    for (const input of [folderUploadRef.current, knowledgeFolderUploadRef.current]) {
      if (!input) {
        continue
      }

      input.setAttribute('webkitdirectory', '')
      input.setAttribute('directory', '')
    }
  }, [])

  const filteredCases = useMemo(() => {
    if (!appState) {
      return []
    }

    return appState.cases.filter((item) => item.name.includes(caseSearch.trim()))
  }, [appState, caseSearch])

  const selectedCase = useMemo(() => {
    return appState?.cases.find((item) => item.id === selectedCaseId) ?? null
  }, [appState, selectedCaseId])

  const caseEvidences = useMemo(() => {
    return appState?.evidences.filter((item) => item.caseId === selectedCaseId) ?? []
  }, [appState, selectedCaseId])
  const caseEvidenceInsights = useMemo(() => {
    return (
      appState?.evidenceInsights
        .filter((item) => item.caseId === selectedCaseId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) ?? []
    )
  }, [appState, selectedCaseId])
  const selectedCaseContextMemory = useMemo(() => {
    return (
      appState?.caseContextMemories
        .filter((item) => item.caseId === selectedCaseId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
    )
  }, [appState, selectedCaseId])
  const displayCaseEvidences = useMemo(() => {
    const paths = new Set(caseEvidences.map(getEvidencePreviewSourceKey))
    return [...caseEvidences, ...pendingCaseEvidences.filter(e =>
      e.caseId === selectedCaseId && !paths.has(getEvidencePreviewSourceKey(e)),
    )]
  }, [caseEvidences, pendingCaseEvidences, selectedCaseId])
  const understandingTask = selectedCase?.agent?.task
  const understandingActive = selectedCase?.agent?.autoAnalyze !== false
    && ['queued', 'processing'].includes(understandingTask?.status ?? '')
  const understandingEvidences = caseEvidences.filter(e =>
    understandingTask?.evidenceIds?.includes(e.id),
  )
  const understoodCount = understandingEvidences.filter(e => e.summaryStatus === 'ready').length
  const groupedCaseEvidences = useMemo(() => groupEvidencesByFolder(caseEvidences), [caseEvidences])
  const evidenceFolderTree = useMemo(() => buildEvidenceFolderTree(displayCaseEvidences), [displayCaseEvidences])
  const evidenceTreeRows = useMemo(() => flattenEvidenceTree(evidenceFolderTree), [evidenceFolderTree])
  const normalizedLoginAccount = loginAccount.trim()
  const sidebarPrimaryIdentity = appState?.user.email?.trim() || normalizedLoginAccount || appState?.user.name?.trim() || '未登录'
  const evidenceFolderCount = useMemo(() => countEvidenceFolderTree(evidenceFolderTree), [evidenceFolderTree])
  const linkedFolderSummary = useMemo(() => {
    if (pendingCaseEvidences.length) {
      return `已识别 ${pendingCaseEvidences.length} 个文件`
    }

    if (!caseEvidences.length) {
      return '尚未链接本地证据目录'
    }

    const rootFolders = Array.from(
      new Set(
        caseEvidences.map((item) => {
          const relativePath = getEvidenceDirectoryParts(item).relativePath
          return relativePath.split('/')[0] || '根目录'
        }),
      ),
    )

    if (rootFolders.length === 1) {
      return rootFolders[0]
    }

    return `${rootFolders.slice(0, 2).join(' / ')}${rootFolders.length > 2 ? ` 等 ${rootFolders.length} 个目录` : ''}`
  }, [caseEvidences, pendingCaseEvidences])
  const shouldShowEmptyCaseOnboarding = Boolean(appState && appState.cases.length === 0)
  const shouldShowFolderLinkOnboarding = Boolean(
    selectedCase
    && caseEvidences.length === 0
    && entryOnboardingStep === 'link-folder',
  )

  function renderFolderLinkGuidePopup() {
    if (!shouldShowFolderLinkOnboarding) {
      return null
    }

    return (
      <aside className="case-entry-guide-popup" role="status" aria-live="polite">
        <button
          aria-label="关闭提示"
          className="case-entry-guide-popup-close"
          type="button"
          onClick={() => setEntryOnboardingStep('idle')}
          disabled={isSubmitting}
        >
          ×
        </button>
        <div className="case-entry-guide-popup-body">
          <span className="eyebrow">下一步</span>
          <h2>请先链接本地文件夹</h2>
          <p>案件已经建立完成。把电脑里的案件材料目录接进来后，就可以继续整理证据和生成文书。</p>
        </div>
        <div className="case-entry-guide-actions case-entry-guide-popup-actions">
          <button className="primary-button" type="button" onClick={() => void handleLinkFolder()} disabled={isSubmitting || Boolean(evidenceImportProgress)}>
            链接本地文件夹
          </button>
          <button className="ghost-button" type="button" onClick={() => setEntryOnboardingStep('idle')} disabled={isSubmitting}>
            稍后处理
          </button>
        </div>
      </aside>
    )
  }

  const caseCertificates = useMemo(() => {
    return (
      appState?.certificates
        .filter((item) => item.caseId === selectedCaseId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? []
    )
  }, [appState, selectedCaseId])

  const activeCertificate = useMemo(() => {
    return caseCertificates.find((item) => item.id === selectedCertificateId) ?? caseCertificates[0] ?? null
  }, [caseCertificates, selectedCertificateId])
  const activeDraftMemory = useMemo(() => {
    if (!activeCertificate) {
      return null
    }

    return appState?.draftMemories.find((item) => item.certificateId === activeCertificate.id) ?? null
  }, [activeCertificate, appState])

  const activeParagraph = useMemo(() => {
    return activeCertificate?.paragraphs.find((item) => item.id === activeParagraphId) ?? activeCertificate?.paragraphs[0] ?? null
  }, [activeCertificate, activeParagraphId])
  const activeParagraphOrder = useMemo(() => {
    if (!activeCertificate || !activeParagraph) {
      return null
    }

    const paragraphIndex = activeCertificate.paragraphs.findIndex((item) => item.id === activeParagraph.id)
    return paragraphIndex >= 0 ? paragraphIndex + 1 : null
  }, [activeCertificate, activeParagraph])

  const activeCertificateEvidenceIds = useMemo(() => {
    if (!activeCertificate) {
      return []
    }

    return Array.from(new Set(activeCertificate.paragraphs.flatMap((paragraph) =>
      getParagraphLinks(paragraph).map((link) => link.evidenceId),
    )))
  }, [activeCertificate])

  const activeParagraphLinks = useMemo(() => getParagraphLinks(activeParagraph), [activeParagraph])
  const activeSentenceSelection = useMemo(
    () => resolveParagraphSentenceSelection(activeParagraph, {
      sentenceIndex: activeSentenceIndex ?? undefined,
      sentenceText: activeSentenceText,
    }),
    [activeParagraph, activeSentenceIndex, activeSentenceText],
  )
  const activeSentenceLinkageFocus = useMemo(
    () => activeParagraph?.linkageFocus?.find(item => item.sentenceIndex === activeSentenceSelection.index
      && normalizeSentenceAnchorText(item.sentenceText) === normalizeSentenceAnchorText(activeSentenceSelection.text)),
    [activeParagraph, activeSentenceSelection],
  )

  function syncActiveSentence(
    paragraph: CertificateParagraph | null | undefined,
    anchor?: SentenceAnchorLike | null,
    options: {
      syncInsight?: boolean
    } = {},
  ) {
    const nextSelection = resolveParagraphSentenceSelection(paragraph, anchor)
    setActiveSentenceIndex(nextSelection.index)
    setActiveSentenceText(nextSelection.text)

    if (!paragraph || nextSelection.index == null || options.syncInsight === false) {
      return
    }

    setManualPreviewEvidenceId(null)
    setImageViewerState(null)
    setIsIdeAssistantVisible(false)
    const sentenceLinkIndex = getParagraphLinks(paragraph).findIndex((link) => sentenceAnchorMatches(link, nextSelection))
    setActiveReferenceIndex(sentenceLinkIndex)
    if (sentenceLinkIndex >= 0) {
      setVerifyInsightTab('evidence')
      return
    }

    const sentenceStatuteReference = getParagraphReferences(paragraph, 'statute')
      .find((reference) => sentenceAnchorMatches(reference, nextSelection))
    if (sentenceStatuteReference) {
      setSelectedKnowledgeReferenceId(getReferenceIdentity(sentenceStatuteReference))
      setVerifyInsightTab('statute')
      return
    }

    const sentenceCaseReference = getParagraphReferences(paragraph, 'case')
      .find((reference) => sentenceAnchorMatches(reference, nextSelection))
    if (sentenceCaseReference) {
      setSelectedKnowledgeReferenceId(getReferenceIdentity(sentenceCaseReference))
      setVerifyInsightTab('case')
      return
    }
    setSelectedKnowledgeReferenceId(null)
    setVerifyInsightTab('evidence')
  }

  const activeLink = useMemo(() => {
    if (!activeParagraphLinks.length) {
      return null
    }

    const selectedLink = activeParagraphLinks[activeReferenceIndex]
    return selectedLink && sentenceAnchorMatches(selectedLink, activeSentenceSelection)
      ? selectedLink
      : activeParagraphLinks.find((link) => sentenceAnchorMatches(link, activeSentenceSelection)) ?? null
  }, [activeParagraphLinks, activeReferenceIndex, activeSentenceSelection])

  const activeEvidence = useMemo(() => {
    if (!activeLink) {
      return null
    }

    return caseEvidences.find((item) => item.id === activeLink.evidenceId) ?? null
  }, [activeLink, caseEvidences])

  useEffect(() => {
    const nextSelection = resolveParagraphSentenceSelection(activeParagraph, {
      sentenceIndex: activeSentenceIndex ?? undefined,
      sentenceText: activeSentenceText,
    })

    if (nextSelection.index === activeSentenceIndex && nextSelection.text === activeSentenceText) {
      return
    }

    setActiveSentenceIndex(nextSelection.index)
    setActiveSentenceText(nextSelection.text)
  }, [activeParagraph?.id, activeParagraph?.text])
  const isAutoLinkingActiveCertificate = autoLinkingCertificateId === activeCertificate?.id
  const livePreviewEvidence = useMemo(() => {
    if (manualPreviewEvidenceId) {
      return displayCaseEvidences.find((item) => item.id === manualPreviewEvidenceId) ?? null
    }

    return activeEvidence
  }, [activeEvidence, displayCaseEvidences, manualPreviewEvidenceId])
  const previewEvidence = useMemo(() => {
    if (manualPreviewEvidenceId || !isAutoLinkingActiveCertificate || !lockedPreviewEvidenceId) {
      return livePreviewEvidence
    }

    return (
      displayCaseEvidences.find((item) => item.id === lockedPreviewEvidenceId)
      ?? caseEvidences.find((item) => item.id === lockedPreviewEvidenceId)
      ?? livePreviewEvidence
    )
  }, [
    caseEvidences,
    displayCaseEvidences,
    isAutoLinkingActiveCertificate,
    livePreviewEvidence,
    lockedPreviewEvidenceId,
    manualPreviewEvidenceId,
  ])
  const livePreviewLink = useMemo(() => {
    if (!manualPreviewEvidenceId) {
      return activeLink
    }

    return (
      activeParagraphLinks.find((link) =>
        link.evidenceId === manualPreviewEvidenceId && sentenceAnchorMatches(link, activeSentenceSelection),
      )
      ?? activeParagraphLinks.find((link) => link.evidenceId === manualPreviewEvidenceId)
      ?? null
    )
  }, [activeLink, activeParagraphLinks, activeSentenceSelection, manualPreviewEvidenceId])
  const previewLink = useMemo(() => {
    if (!previewEvidence) {
      return null
    }

    return (
      activeParagraphLinks.find((link) =>
        link.evidenceId === previewEvidence.id && sentenceAnchorMatches(link, activeSentenceSelection),
      )
      ?? activeParagraphLinks.find((link) => link.evidenceId === previewEvidence.id)
      ?? livePreviewLink
    )
  }, [activeParagraphLinks, activeSentenceSelection, livePreviewLink, previewEvidence])
  const isManualEvidencePreview = Boolean(
    manualPreviewEvidenceId && previewEvidence?.id === manualPreviewEvidenceId,
  )
  const previewSource = useMemo(() => {
    if (!previewEvidence) {
      return undefined
    }

    const previewWorkspaceAccount = loginAccount || appState?.user.email || undefined

    return (
      localPreviewSourceMap[getEvidencePreviewSourceKey(previewEvidence)]
      ?? getEvidenceSourceUrl(previewEvidence.id, previewWorkspaceAccount)
    )
  }, [appState?.user.email, localPreviewSourceMap, loginAccount, previewEvidence])
  useEffect(() => {
    // #region debug-point D:preview-state
    fetch('http://127.0.0.1:7777/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'backend-file-load',
        runId: 'pre-fix',
        hypothesisId: 'D',
        location: 'app/src/App.tsx',
        msg: '[DEBUG] preview-state-changed',
        data: {
          previewEvidenceId: previewEvidence?.id ?? null,
          previewFileName: previewEvidence?.fileName ?? null,
          previewType: previewEvidence?.type ?? null,
          previewSource: previewSource ?? null,
          previewPanelMode,
          manualPreviewEvidenceId,
          activeParagraphId,
          activeReferenceIndex,
        },
        ts: Date.now(),
      }),
    }).catch(() => {})
    // #endregion
  }, [
    activeParagraphId,
    activeReferenceIndex,
    manualPreviewEvidenceId,
    previewEvidence?.fileName,
    previewEvidence?.id,
    previewEvidence?.type,
    previewPanelMode,
    previewSource,
  ])
  const evidenceInsightByEvidenceId = useMemo(() => {
    return new Map(caseEvidenceInsights.map((item) => [item.evidenceId, item]))
  }, [caseEvidenceInsights])
  const paragraphMemoryCards = useMemo(() => {
    if (!activeCertificate) {
      return []
    }

    return activeCertificate.paragraphs.map((paragraph, index) => {
      const linkedEvidences = getParagraphEvidences(paragraph)
      const evidenceNumbers = linkedEvidences.map((evidence) => evidence.number)
      const evidenceInsightSources = linkedEvidences.map((evidence) => ({
        evidence,
        insight: evidenceInsightByEvidenceId.get(evidence.id) ?? null,
      }))
      const supportFacts = (selectedCaseContextMemory?.supportMatrix ?? []).filter((item) =>
        item.evidenceNumbers.some((number) => evidenceNumbers.includes(number)),
      )
      const paragraphPlan = activeDraftMemory?.paragraphPlans.find((item) => item.paragraphId === paragraph.id) ?? null

      return {
        paragraph,
        paragraphIndex: index + 1,
        isActive: paragraph.id === activeParagraph?.id,
        evidenceNumbers,
        evidenceInsightSources,
        supportFacts,
        paragraphPlan,
      }
    })
  }, [
    activeCertificate,
    activeDraftMemory,
    activeParagraph?.id,
    evidenceInsightByEvidenceId,
    selectedCaseContextMemory,
    caseEvidences,
  ])

  function getParagraphEvidences(paragraph: CertificateParagraph) {
    return getParagraphLinks(paragraph)
      .map((link) => caseEvidences.find((item) => item.id === link.evidenceId) ?? null)
      .filter((item): item is Evidence => Boolean(item))
  }

  const verifiedParagraphCount = useMemo(() => {
    return activeCertificate?.paragraphs.filter((item) => item.verified).length ?? 0
  }, [activeCertificate])

  const canMarkCaseReady = useMemo(() => {
    if (!selectedCase || !activeCertificate) {
      return false
    }

    return activeCertificate.paragraphs.length > 0 && activeCertificate.paragraphs.every((item) => item.verified)
  }, [selectedCase, activeCertificate])

  const unlinkedParagraphCount = useMemo(() => {
    return activeCertificate?.paragraphs.filter((paragraph) => {
      const links = getParagraphLinks(paragraph)
      if (!paragraph.linkageFocus) return links.length === 0
      return paragraph.linkageFocus.some(focus => focus.priority !== 'skip' && focus.evidenceNeeded
        && !links.some(link => sentenceAnchorMatches(link, { index: focus.sentenceIndex, text: focus.sentenceText })))
    }).length ?? 0
  }, [activeCertificate])

  const recentCases = useMemo(() => {
    return [...(appState?.cases ?? [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3)
  }, [appState])

  const activeParagraphReferences = useMemo(() => getParagraphReferences(activeParagraph), [activeParagraph])
  const activeStatuteReferences = useMemo(
    () => getParagraphReferences(activeParagraph, 'statute'),
    [activeParagraph],
  )
  const activeCaseReferences = useMemo(
    () => getParagraphReferences(activeParagraph, 'case'),
    [activeParagraph],
  )
  const activeSentenceEvidenceLinks = useMemo(
    () => activeParagraphLinks.filter((link) => sentenceAnchorMatches(link, activeSentenceSelection)),
    [activeParagraphLinks, activeSentenceSelection],
  )
  const activeSentenceStatuteReferences = useMemo(
    () => activeStatuteReferences.filter((reference) => sentenceAnchorMatches(reference, activeSentenceSelection)),
    [activeSentenceSelection, activeStatuteReferences],
  )
  const activeSentenceCaseReferences = useMemo(
    () => activeCaseReferences.filter((reference) => sentenceAnchorMatches(reference, activeSentenceSelection)),
    [activeCaseReferences, activeSentenceSelection],
  )
  const linkageStatusMessage = useMemo(() => {
    if (isAutoLinkingActiveCertificate) {
      return {
        tone: 'loading' as const,
        text: autoLinkFeedback?.tone === 'loading' ? autoLinkFeedback.text : '正在读取文书与案件材料',
      }
    }

    if (autoLinkFeedback) {
      return autoLinkFeedback
    }

    if (!activeParagraph) {
      return {
        tone: 'info' as const,
        text: '请选择需要核验的段落或句子。',
      }
    }

    const scopeLabel = activeSentenceSelection.index != null
      ? `第 ${activeSentenceSelection.index + 1} 句`
      : activeParagraphOrder
        ? `第 ${activeParagraphOrder} 段`
        : '当前段落'

    if (
      activeSentenceEvidenceLinks.length
      || activeSentenceStatuteReferences.length
      || activeSentenceCaseReferences.length
    ) {
      return {
        tone: 'success' as const,
        text: `${scopeLabel}已联动 ${activeSentenceEvidenceLinks.length} 条证据、${activeSentenceStatuteReferences.length} 条法条、${activeSentenceCaseReferences.length} 个案例。`,
      }
    }

    if (activeSentenceLinkageFocus?.priority === 'skip') {
      return { tone: 'info' as const, text: '本句无需自动关联。' }
    }

    if (activeParagraphLinks.length || activeStatuteReferences.length || activeCaseReferences.length) {
      return {
        tone: 'info' as const,
        text: `${scopeLabel}暂未联动，可直接选择证据快速绑定。`,
      }
    }

    return {
      tone: 'info' as const,
      text: '当前段落还没有联动内容，可点击“证据联动”自动匹配。',
    }
  }, [
    activeCaseReferences.length,
    activeParagraph,
    activeParagraphLinks.length,
    activeParagraphOrder,
    activeSentenceCaseReferences.length,
    activeSentenceEvidenceLinks.length,
    activeSentenceSelection.index,
    activeSentenceLinkageFocus,
    activeSentenceStatuteReferences.length,
    activeStatuteReferences.length,
    autoLinkFeedback,
    isAutoLinkingActiveCertificate,
  ])

  const selectedStatuteReference = useMemo(() => {
    return (
      activeSentenceStatuteReferences.find((reference) => getReferenceIdentity(reference) === selectedKnowledgeReferenceId)
      ?? activeSentenceStatuteReferences[0]
      ?? null
    )
  }, [activeSentenceStatuteReferences, selectedKnowledgeReferenceId])

  const selectedCaseReference = useMemo(() => {
    return (
      activeSentenceCaseReferences.find((reference) => getReferenceIdentity(reference) === selectedKnowledgeReferenceId)
      ?? activeSentenceCaseReferences[0]
      ?? null
    )
  }, [activeSentenceCaseReferences, selectedKnowledgeReferenceId])

  const selectedStatuteReferenceBinding = useMemo(
    () => findBestStatuteBindingForReference(appState?.knowledgeStatutes ?? [], selectedStatuteReference),
    [appState?.knowledgeStatutes, selectedStatuteReference],
  )

  const selectedCaseReferenceBinding = useMemo(() => {
    if (!selectedCaseReference) {
      return null
    }

    for (const entry of appState?.knowledgeCases ?? []) {
      const excerpt = entry.excerpts.find((item) => item.id === selectedCaseReference.targetId)
      if (excerpt) {
        return { entry, excerpt }
      }
    }

    return null
  }, [appState?.knowledgeCases, selectedCaseReference])

  const knowledgeContext = useMemo(() => {
    return [
      selectedCase?.name ?? '',
      selectedCase?.description ?? '',
      activeCertificate?.focus ?? '',
      activeParagraph?.text ?? '',
      activeSentenceText,
    ]
      .filter(Boolean)
      .join(' ')
  }, [selectedCase, activeCertificate?.focus, activeParagraph?.text, activeSentenceText])

  const filteredKnowledgeCases = useMemo(() => {
    const entries = appState?.knowledgeCases ?? []
    const keyword = knowledgeKeyword.trim()

    const ranked = entries
      .map((entry) => ({
        entry,
        score:
          scoreByKeywordOverlap(
            keyword || knowledgeContext,
            [
              entry.title,
              entry.caseNumber,
              entry.cause,
              entry.issueSummary,
              entry.holdingSummary,
              entry.reasoningSummary,
              ...entry.keywords,
              ...entry.focusTags,
              ...entry.referencedStatutes,
              ...entry.excerpts.flatMap((excerpt) => [excerpt.content, excerpt.summary, ...excerpt.keywords]),
            ],
          ) + (keyword ? 0 : entry.focusTags.length),
      }))
      .filter(({ entry, score }) => {
        if (!keyword) {
          return score > 0 || !knowledgeContext
        }

        return (
          score > 0
          || [
            entry.title,
            entry.caseNumber,
            entry.courtName,
            entry.cause,
            ...entry.keywords,
            ...entry.focusTags,
          ].some((item) => item.includes(keyword))
        )
      })
      .sort((left, right) => right.score - left.score)

    return ranked.map((item) => item.entry)
  }, [appState?.knowledgeCases, knowledgeContext, knowledgeKeyword])

  const filteredKnowledgeStatutes = useMemo(() => {
    const entries = appState?.knowledgeStatutes ?? []
    const keyword = knowledgeKeyword.trim()

    const ranked = entries
      .map((entry) => ({
        entry,
        score: scoreByKeywordOverlap(
          keyword || knowledgeContext,
          [
            entry.title,
            entry.docType,
            entry.issuer,
            ...entry.keywords,
            ...entry.articles.flatMap((article) => [
              article.articleNumber,
              article.content,
              ...article.aliases,
              ...article.topicTags,
            ]),
          ],
        ),
      }))
      .filter(({ entry, score }) => {
        if (!keyword) {
          return score > 0 || !knowledgeContext
        }

        return (
          score > 0
          || [entry.title, entry.docType, entry.issuer, ...entry.keywords].some((item) => item.includes(keyword))
        )
      })
      .sort((left, right) => right.score - left.score)

    return ranked.map((item) => item.entry)
  }, [appState?.knowledgeStatutes, knowledgeContext, knowledgeKeyword])

  const fallbackRecommendedKnowledgeCases = useMemo(() => filteredKnowledgeCases.slice(0, 3), [filteredKnowledgeCases])
  const recommendedKnowledgeCases = useMemo(
    () => activeSentenceLinkageFocus && !activeSentenceLinkageFocus.caseNeeded ? []
      : (remoteRecommendedKnowledgeCases.length ? remoteRecommendedKnowledgeCases : fallbackRecommendedKnowledgeCases).slice(0, 3),
    [activeSentenceLinkageFocus, fallbackRecommendedKnowledgeCases, remoteRecommendedKnowledgeCases],
  )
  const recommendedKnowledgeStatutes = useMemo(
    () => activeSentenceLinkageFocus && !activeSentenceLinkageFocus.statuteNeeded ? []
      : (remoteRecommendedKnowledgeStatutes.length ? remoteRecommendedKnowledgeStatutes : filteredKnowledgeStatutes).slice(0, 3),
    [activeSentenceLinkageFocus, filteredKnowledgeStatutes, remoteRecommendedKnowledgeStatutes],
  )

  const selectedKnowledgeCase = useMemo(() => {
    return (
      filteredKnowledgeCases.find((item) => item.id === selectedKnowledgeCaseId)
      ?? filteredKnowledgeCases[0]
      ?? null
    )
  }, [filteredKnowledgeCases, selectedKnowledgeCaseId])

  const selectedStatute = useMemo(() => {
    return (
      filteredKnowledgeStatutes.find((item) => item.id === selectedStatuteId)
      ?? filteredKnowledgeStatutes[0]
      ?? null
    )
  }, [filteredKnowledgeStatutes, selectedStatuteId])

  const selectedStatuteArticle = useMemo(() => {
    if (!selectedStatute) {
      return null
    }

    return selectedStatute.articles.find((item) => item.id === selectedArticleId) ?? selectedStatute.articles[0] ?? null
  }, [selectedArticleId, selectedStatute])

  const selectedStatuteReferenceInterpretations = useMemo(
    () => buildRelatedInterpretationArticles(
      appState?.knowledgeStatutes ?? [],
      selectedStatuteReferenceBinding?.document ?? null,
      selectedStatuteReferenceBinding?.article ?? null,
    ),
    [appState?.knowledgeStatutes, selectedStatuteReferenceBinding],
  )

  const selectedStatuteReferenceKnowledgePreview = useMemo(
    () => findKnowledgeFileStatutePreview(
      appState?.knowledgeFiles ?? [],
      selectedStatuteReferenceBinding?.document ?? null,
      selectedStatuteReferenceBinding?.article ?? null,
    ),
    [appState?.knowledgeFiles, selectedStatuteReferenceBinding],
  )

  const selectedKnowledgeInterpretations = useMemo(
    () => buildRelatedInterpretationArticles(
      appState?.knowledgeStatutes ?? [],
      selectedStatute,
      selectedStatuteArticle,
    ),
    [appState?.knowledgeStatutes, selectedStatute, selectedStatuteArticle],
  )

  const filteredSettingsKnowledgeFiles = useMemo(() => {
    const entries = [...(appState?.knowledgeFiles ?? [])]
    const keyword = settingsKnowledgeFileKeyword.trim()

    const filtered = keyword
      ? entries.filter((entry) =>
          [
            entry.title,
            entry.fileName,
            entry.summary,
            entry.extractedText,
            ...entry.vectorKeywords,
          ].some((item) => item.includes(keyword)),
        )
      : entries

    return filtered.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title, 'zh-CN'),
    )
  }, [appState?.knowledgeFiles, settingsKnowledgeFileKeyword])

  const selectedSettingsKnowledgeFile = useMemo(() => {
    return (
      filteredSettingsKnowledgeFiles.find((item) => item.id === settingsSelectedKnowledgeFileId)
      ?? filteredSettingsKnowledgeFiles[0]
      ?? null
    )
  }, [filteredSettingsKnowledgeFiles, settingsSelectedKnowledgeFileId])

  const filteredSettingsStatutes = useMemo(() => {
    const entries = [...(appState?.knowledgeStatutes ?? [])]
    const keyword = settingsStatuteKeyword.trim()

    const filtered = keyword
      ? entries.filter((entry) =>
          [
            entry.title,
            entry.docType,
            entry.issuer,
            ...entry.keywords,
            ...entry.articles.flatMap((article) => [
              article.articleNumber,
              article.content,
              ...article.aliases,
              ...article.topicTags,
            ]),
          ].some((item) => item.includes(keyword)),
        )
      : entries

    return filtered.sort((left, right) => {
      if (left.docType === right.docType) {
        return right.effectiveDate.localeCompare(left.effectiveDate) || left.title.localeCompare(right.title, 'zh-CN')
      }

      if (left.docType === '法律') {
        return -1
      }

      if (right.docType === '法律') {
        return 1
      }

      return left.docType.localeCompare(right.docType, 'zh-CN')
    })
  }, [appState?.knowledgeStatutes, settingsStatuteKeyword])

  const selectedSettingsStatute = useMemo(() => {
    return (
      filteredSettingsStatutes.find((item) => item.id === settingsSelectedStatuteId)
      ?? filteredSettingsStatutes[0]
      ?? null
    )
  }, [filteredSettingsStatutes, settingsSelectedStatuteId])

  const selectedSettingsArticle = useMemo(() => {
    if (!selectedSettingsStatute) {
      return null
    }

    return (
      selectedSettingsStatute.articles.find((item) => item.id === settingsSelectedArticleId)
      ?? selectedSettingsStatute.articles[0]
      ?? null
    )
  }, [settingsSelectedArticleId, selectedSettingsStatute])

  useEffect(() => {
    if (!activeParagraphLinks.length) {
      if (activeReferenceIndex !== 0) {
        setActiveReferenceIndex(0)
      }
      setLocatorDraft('段落 1')
      return
    }

    if (activeReferenceIndex >= activeParagraphLinks.length) {
      setActiveReferenceIndex(0)
      return
    }

    setLocatorDraft(activeParagraphLinks[activeReferenceIndex]?.locator ?? '段落 1')
  }, [activeParagraphId, activeParagraphLinks, activeReferenceIndex])

  useEffect(() => {
    setPreviewPanelMode('preview')
  }, [previewEvidence?.id])

  useEffect(() => {
    if (!previewEvidence) {
      return
    }

    if (isAutoLinkingActiveCertificate || evidenceImportProgress || directoryPreparation || understandingActive || !previewEvidence.storageKey && previewEvidence.directoryId) {
      return
    }

    if (summarizingEvidenceId === previewEvidence.id) {
      return
    }

    if (previewEvidence.summaryText?.trim()) {
      return
    }

    if (previewEvidence.summaryStatus === 'failed' || previewEvidence.summaryStatus === 'processing') {
      return
    }

    if (!cloudAuthToken?.trim()) {
      return
    }

    void handleSummarizeEvidence(previewEvidence.id, { silent: true })
  }, [
    activeCertificate?.id,
    cloudAuthToken,
    isAutoLinkingActiveCertificate,
    previewEvidence,
    previewEvidence?.id,
    previewEvidence?.summaryStatus,
    previewEvidence?.summaryText,
    evidenceImportProgress,
    directoryPreparation,
    understandingActive,
    summarizingEvidenceId,
  ])

  useEffect(() => {
    if (!imageViewerState) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setImageViewerState(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [imageViewerState])

  useEffect(() => {
    if (!manualPreviewEvidenceId) {
      return
    }

    const exists = displayCaseEvidences.some((item) => item.id === manualPreviewEvidenceId)
    if (!exists) {
      setManualPreviewEvidenceId(null)
    }
  }, [displayCaseEvidences, manualPreviewEvidenceId, setManualPreviewEvidenceId])

  useEffect(() => {
    let cancelled = false

    if ((activeSentenceLinkageFocus && !activeSentenceLinkageFocus.caseNeeded)
      || (!selectedCase && !activeParagraph && !activeSentenceText && !activeCertificate?.focus)) {
      setRemoteRecommendedKnowledgeCases([])
      return () => {
        cancelled = true
      }
    }

    void api.recommendKnowledgeCases({
      caseId: selectedCase?.id,
      paragraphText: activeSentenceText || activeParagraph?.text || undefined,
      focus: activeCertificate?.focus || selectedCase?.description || undefined,
    })
      .then(({ items }) => {
        if (cancelled) {
          return
        }

        setRemoteRecommendedKnowledgeCases(Array.isArray(items) ? items : [])
      })
      .catch(() => {
        if (cancelled) {
          return
        }

        setRemoteRecommendedKnowledgeCases([])
      })

    return () => {
      cancelled = true
    }
  }, [activeCertificate?.focus, activeParagraph, activeSentenceLinkageFocus, activeSentenceText, selectedCase])

  useEffect(() => {
    let cancelled = false

    if ((activeSentenceLinkageFocus && !activeSentenceLinkageFocus.statuteNeeded)
      || (!selectedCase && !activeParagraph && !activeSentenceText && !activeCertificate?.focus)) {
      setRemoteRecommendedKnowledgeStatutes([])
      return () => {
        cancelled = true
      }
    }

    void api.recommendKnowledgeStatutes({
      caseId: selectedCase?.id,
      paragraphText: activeSentenceText || activeParagraph?.text || undefined,
      focus: activeCertificate?.focus || selectedCase?.description || undefined,
    })
      .then(({ items }) => {
        if (cancelled) {
          return
        }

        setRemoteRecommendedKnowledgeStatutes(Array.isArray(items) ? items : [])
      })
      .catch(() => {
        if (cancelled) {
          return
        }

        setRemoteRecommendedKnowledgeStatutes([])
      })

    return () => {
      cancelled = true
    }
  }, [activeCertificate?.focus, activeParagraph, activeSentenceLinkageFocus, activeSentenceText, selectedCase])

  useEffect(() => {
    if (!selectedKnowledgeCase && filteredKnowledgeCases.length) {
      setSelectedKnowledgeCaseId(filteredKnowledgeCases[0].id)
    }
  }, [filteredKnowledgeCases, selectedKnowledgeCase])

  useEffect(() => {
    if (!selectedStatute && filteredKnowledgeStatutes.length) {
      setSelectedStatuteId(filteredKnowledgeStatutes[0].id)
    }
  }, [filteredKnowledgeStatutes, selectedStatute])

  useEffect(() => {
    if (!selectedStatuteArticle && selectedStatute?.articles.length) {
      setSelectedArticleId(selectedStatute.articles[0].id)
    }
  }, [selectedStatute, selectedStatuteArticle])

  useEffect(() => {
    if (!selectedSettingsStatute && filteredSettingsStatutes.length) {
      setSettingsSelectedStatuteId(filteredSettingsStatutes[0].id)
    }
  }, [filteredSettingsStatutes, selectedSettingsStatute])

  useEffect(() => {
    if (!selectedSettingsArticle && selectedSettingsStatute?.articles.length) {
      setSettingsSelectedArticleId(selectedSettingsStatute.articles[0].id)
    }
  }, [selectedSettingsArticle, selectedSettingsStatute])

  useEffect(() => {
    if (!selectedSettingsKnowledgeFile && filteredSettingsKnowledgeFiles.length) {
      setSettingsSelectedKnowledgeFileId(filteredSettingsKnowledgeFiles[0].id)
    }
  }, [filteredSettingsKnowledgeFiles, selectedSettingsKnowledgeFile])

  useEffect(() => {
    const shouldFocusSettings = activeTab === 'settings' || isKnowledgeLibraryDialogOpen
    if (!shouldFocusSettings) {
      return
    }

    const target = settingsTab === 'files'
      ? settingsKnowledgeFilesSectionRef.current
      : settingsStatutesSectionRef.current

    if (!target) {
      return
    }

    window.requestAnimationFrame(() => {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
  }, [activeTab, isKnowledgeLibraryDialogOpen, settingsTab])

  useEffect(() => {
    if (verifyInsightTab === 'statute') {
      const nextReference = selectedStatuteReference
      setSelectedKnowledgeReferenceId(nextReference ? getReferenceIdentity(nextReference) : null)
      return
    }

    if (verifyInsightTab === 'case') {
      const nextReference = selectedCaseReference
      setSelectedKnowledgeReferenceId(nextReference ? getReferenceIdentity(nextReference) : null)
      return
    }

    setSelectedKnowledgeReferenceId(null)
  }, [verifyInsightTab, selectedStatuteReference, selectedCaseReference])

  async function runMutation(task: () => Promise<void>) {
    try {
      setIsSubmitting(true)
      setErrorMessage('')
      await task()
      return true
    } catch (error) {
      if (isCloudAuthApiError(error)) {
        handleCloudSessionExpired(error.message)
        return false
      }

      setErrorMessage(error instanceof Error ? error.message : '操作失败')
      window.alert(error instanceof Error ? error.message : '操作失败')
      return false
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleLogin() {
    if (isSubmitting) {
      return
    }

    if (!loginForm.account.trim()) {
      window.alert('请输入账号中心注册邮箱。')
      return
    }

    const trimmedAccount = loginForm.account.trim().toLowerCase()
    if (!isEmailAccount(trimmedAccount)) {
      window.alert('桌面端已与平台账号中心统一，请使用官网注册邮箱登录。')
      return
    }

    await runMutation(async () => {
      const cloudLogin = await api.loginCloudAccount({
        email: trimmedAccount,
        password: loginForm.password,
      })
      const nextProfile: CloudAccountSessionProfile = {
        email: cloudLogin.user.email,
        name: cloudLogin.user.name,
        organization: cloudLogin.organization.name,
        role: cloudLogin.organization.role,
      }
      cloudAccountProfileRef.current = nextProfile
      persistCloudAuthToken(cloudLogin.token)
      await completeDesktopAuthSession(trimmedAccount, nextProfile)
      setEntryOnboardingStep('create-case')
    })
  }

  async function handleRegister() {
    if (isSubmitting) {
      return
    }

    const email = registerForm.email.trim().toLowerCase()
    if (!registerForm.organizationName.trim()) {
      window.alert('请输入机构名称。')
      return
    }

    if (!registerForm.ownerName.trim()) {
      window.alert('请输入负责人姓名。')
      return
    }

    if (!email) {
      window.alert('请输入注册邮箱。')
      return
    }

    await runMutation(async () => {
      let cloudRegister: Awaited<ReturnType<typeof api.registerCloudAccount>>
      try {
        cloudRegister = await api.registerCloudAccount({
          organizationName: registerForm.organizationName.trim(),
          ownerName: registerForm.ownerName.trim(),
          email,
          password: registerForm.password,
          inviteCode: registerForm.inviteCode?.trim() || undefined,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : '平台注册失败。'
        const shouldFallbackToWebsite = message.includes('当前无法连接平台账户服务')
          || message.includes('未配置平台账户服务地址')
          || message.includes('本地联调账户服务')

        if (!shouldFallbackToWebsite) {
          throw error
        }

        if (!ACCOUNT_CENTER_BASE_URL) {
          throw new Error('当前安装包尚未配置正式官网地址，需要补齐官网域名后重新打包。')
        }

        if (isLocalOriginUrl(ACCOUNT_CENTER_BASE_URL)) {
          throw new Error(`${message} 当前安装包仍使用本地联调官网地址 ${ACCOUNT_CENTER_BASE_URL}，需要改为正式官网地址后重新打包。`)
        }

        await openExternalUrl(getAccountCenterRegisterUrl())
        setErrorMessage('当前桌面端暂时无法直连注册服务，已为你打开官网注册页。注册完成后回到桌面端直接登录即可。')
        return
      }

      const nextProfile: CloudAccountSessionProfile = {
        email: cloudRegister.user.email,
        name: cloudRegister.user.name,
        organization: cloudRegister.organization.name,
        role: cloudRegister.organization.role,
      }
      cloudAccountProfileRef.current = nextProfile
      persistCloudAuthToken(cloudRegister.token)
      await completeDesktopAuthSession(email, nextProfile)
      setEntryOnboardingStep('create-case')
    })
  }

  function handleCloudSessionExpired(message?: string) {
    const nextMessage = message?.trim() || '当前账号已在另一台设备登录，本设备已下线，请重新登录。'
    handleLogout()
    setErrorMessage(nextMessage)
    window.alert(nextMessage)
  }

  function handleLogout() {
    if (localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY)?.trim()) {
      void api.logoutCloudAccount().catch(() => {
        // 退出时优先保证本地登录态清理完成。
      })
    }

    sessionStorage.removeItem(AUTH_STORAGE_KEY)
    sessionStorage.removeItem(LOGIN_ACCOUNT_STORAGE_KEY)
    localStorage.removeItem(AUTH_STORAGE_KEY)
    localStorage.removeItem('lawverify-auth-token')
    localWorkspaceRef.current = null
    cloudAccountProfileRef.current = null
    applyCloudPointSyncState(null)
    persistCloudAuthToken(null)
    setAuthToken(null)
    setLoginAccount('')
    // 登录态失效后必须释放所有旧的加载/提交锁，避免回到认证页后无法继续输入。
    setIsSubmitting(false)
    setIsLoading(false)
    setAppState(null)
    setSelectedCaseId(null)
    setSelectedCertificateId(null)
    setActiveParagraphId(null)
    setSelectedEvidenceIds([])
    setManualPreviewEvidenceId(null)
    setImageViewerState(null)
    streamedDirectoryEvidencesRef.current = []
    setPendingCaseEvidences([])
    setDirectoryPreparation(null)
    clearLocalPreviewSourceMap()
    setActiveSentenceIndex(null)
    setActiveSentenceText('')
    setEntryOnboardingStep('idle')
    setActiveTab('overview')
  }

  function handleSelectCase(caseId: string) {
    if (!appState) {
      return
    }

    const selection = deriveSelection(appState, {
      selectedCaseId: caseId,
      selectedCertificateId: null,
      activeParagraphId: null,
      selectedEvidenceIds: appState.evidences
        .filter((item) => item.caseId === caseId)
        .map((item) => item.id),
    })

    setSelectedCaseId(selection.selectedCaseId)
    setSelectedCertificateId(selection.selectedCertificateId)
    setActiveParagraphId(selection.activeParagraphId)
    setSelectedEvidenceIds(selection.selectedEvidenceIds)
    setManualPreviewEvidenceId(null)
    setImageViewerState(null)
    setLocatorDraft(selection.locatorDraft)
    setActiveReferenceIndex(0)
    setActiveSentenceIndex(getDefaultSentenceIndex(findSelectedParagraph(appState, selection)))
    setActiveSentenceText(getDefaultSentenceText(findSelectedParagraph(appState, selection)))
  }

  function handleSelectCertificate(certificateId: string) {
    const certificate = caseCertificates.find((item) => item.id === certificateId)
    if (!certificate) {
      return
    }

    const firstParagraph = certificate.paragraphs[0] ?? null
    const firstLink = getParagraphLinks(firstParagraph)[0]

    setSelectedCaseId(certificate.caseId)
    setSelectedCertificateId(certificate.id)
    setActiveParagraphId(firstParagraph?.id ?? null)
    setManualPreviewEvidenceId(null)
    setImageViewerState(null)
    setActiveReferenceIndex(0)
    setLocatorDraft(firstLink?.locator ?? '段落 1')
    setActiveSentenceIndex(getDefaultSentenceIndex(firstParagraph))
    setActiveSentenceText(getDefaultSentenceText(firstParagraph))
  }

  function focusParagraph(paragraphId: string | null, nextReferenceIndex = 0) {
    if (!activeCertificate) {
      return
    }

    const paragraph = activeCertificate.paragraphs.find((item) => item.id === paragraphId)
    const links = getParagraphLinks(paragraph)
    const referenceIndex = links[nextReferenceIndex] ? nextReferenceIndex : 0
    setActiveParagraphId(paragraphId)
    setManualPreviewEvidenceId(null)
    setImageViewerState(null)
    setActiveReferenceIndex(referenceIndex)
    setLocatorDraft(links[referenceIndex]?.locator ?? '段落 1')
    syncActiveSentence(paragraph, links[referenceIndex])
  }

  function openCaseCenter(nextTab: CaseCenterTab) {
    setActiveTab('workspace')
    setCaseCenterTab(nextTab)
  }

  function handleOpenCreateCaseDialog() {
    setCaseDialogState({
      mode: 'create',
      title: '新建案件',
      confirmLabel: '创建案件',
      value: '',
    })
  }

  function handleOpenRenameCaseDialog(caseFolder: CaseFolder) {
    setCaseDialogState({
      mode: 'rename',
      caseId: caseFolder.id,
      title: '重命名案件',
      confirmLabel: '保存名称',
      value: caseFolder.name,
    })
  }

  function handleCloseCaseDialog() {
    if (isSubmitting) {
      return
    }

    setCaseDialogState(null)
  }

  function handleOpenAgentWindow(template?: string, mode: 'case' | 'document' = 'document') {
    setAgentMode(mode)
    setIsIdeAssistantVisible(true)
    if (template) {
      setAgentPrompt(template)
    }

    if (!isAgentWindowOpen) {
      const width = Math.min(AGENT_DOCK_EXPANDED_WIDTH, window.innerWidth - AGENT_DOCK_MARGIN * 2)
      const position = agentDockExpandedPositionRef.current ?? {
        x: (window.innerWidth - width) / 2,
        y: window.innerHeight - AGENT_DOCK_EXPANDED_HEIGHT - AGENT_DOCK_MARGIN,
      }
      setAgentDockPosition(clampAgentDockPosition(position, width, AGENT_DOCK_EXPANDED_HEIGHT))
    }
    setIsAgentWindowOpen(true)
  }

  function handleCollapseAgentWindow() {
    agentDockExpandedPositionRef.current = agentDockPosition
    setIsAgentWindowOpen(false)
  }

  function handleStartAgentDockDrag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return
    }

    const dock = agentDockRef.current
    if (!dock) {
      return
    }

    const bounds = dock.getBoundingClientRect()
    agentDockDragRef.current = {
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      startX: event.clientX,
      startY: event.clientY,
    }
    agentDockClickGuardRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsDraggingAgentDock(true)
  }

  function handleExpandAgentDock() {
    if (agentDockClickGuardRef.current) {
      agentDockClickGuardRef.current = false
      return
    }

    handleOpenAgentWindow(undefined, 'case')
  }

  async function handleCreateCase() {
    const name = caseDialogState?.value.trim()
    if (!name) {
      window.alert('请输入案件名称。')
      return
    }

    const shouldAdvanceEntryOnboarding = entryOnboardingStep === 'create-case'

    await runMutation(async () => {
      const { workspace, caseFolder } = await api.createCase(name)
      applyWorkspace(workspace, {
        selectedCaseId: caseFolder.id,
        selectedCertificateId: null,
        activeParagraphId: null,
        selectedEvidenceIds: [],
      })
      openCaseCenter('overview')
      if (shouldAdvanceEntryOnboarding) {
        setEntryOnboardingStep('link-folder')
      }
      setCaseDialogState(null)
    })
  }

  async function handleRenameCase(caseFolder: CaseFolder) {
    const name = caseDialogState?.value.trim()
    if (!name) {
      window.alert('请输入案件名称。')
      return
    }

    await runMutation(async () => {
      const { workspace } = await api.updateCase(caseFolder.id, { name })
      applyWorkspace(workspace, { selectedCaseId: caseFolder.id })
      setCaseDialogState(null)
    })
  }

  async function handleSubmitCaseDialog() {
    if (!caseDialogState) {
      return
    }

    if (caseDialogState.mode === 'create') {
      await handleCreateCase()
      return
    }

    const targetCase = appState?.cases.find((item) => item.id === caseDialogState.caseId)
    if (!targetCase) {
      window.alert('案件不存在，无法重命名。')
      return
    }

    await handleRenameCase(targetCase)
  }

  async function handleDeleteCase(caseFolder: CaseFolder) {
    const confirmed = window.confirm(`确认删除案件“${caseFolder.name}”及其全部证据、质证书吗？`)

    if (!confirmed) {
      return
    }

    await runMutation(async () => {
      const { workspace } = await api.deleteCase(caseFolder.id)
      applyWorkspace(workspace)
    })
  }

  async function handleUpdateCaseDescription(description: string) {
    if (!selectedCase) {
      return
    }

    await runMutation(async () => {
      const { workspace } = await api.updateCase(selectedCase.id, { description })
      applyWorkspace(workspace, { selectedCaseId: selectedCase.id })
    })
  }

  async function handleUpdateCaseStatus(status: CaseFolder['status']) {
    if (!selectedCase) {
      return
    }

    await runMutation(async () => {
      const { workspace } = await api.updateCase(selectedCase.id, { status })
      applyWorkspace(workspace, { selectedCaseId: selectedCase.id, selectedEvidenceIds })
    })
  }

  async function handleRebuildCaseMemory() {
    if (!selectedCase) {
      return
    }

    await runMutation(async () => {
      const { workspace } = await api.rebuildCaseMemory(selectedCase.id)
      applyWorkspace(workspace, { selectedCaseId: selectedCase.id, selectedEvidenceIds })
    })
  }

  async function importEvidenceFiles(fileList: Array<File & { webkitRelativePath?: string }>) {
    if (!selectedCase || !fileList.length) {
      return
    }

    const sortedFileList = sortImportedFiles(fileList)
    const loopState = createProgressLoopState()

    setEvidenceImportResult(null)
    replaceLocalPreviewSourceMap(buildLocalPreviewSourceMap(sortedFileList))
    setPendingCaseEvidences(buildPendingEvidenceItems(selectedCase.id, sortedFileList))
    setEvidenceImportProgress({
      stage: 'parse',
      message: `正在接入原件 0/${sortedFileList.length}`,
      completed: 0,
      total: sortedFileList.length,
    })

    try {
      let latestWorkspace: AppState | null = null
      let currentBatch: Array<File & { webkitRelativePath?: string }> = []
      let currentBatchBytes = 0
      let uploadedCount = 0
      let uploadedBatchCount = 0

      const flushCurrentBatch = async () => {
        if (!currentBatch.length) {
          return
        }

        uploadedBatchCount += 1
        setEvidenceImportProgress({
          stage: 'parse',
          message: `正在接入第 ${uploadedBatchCount} 批原件（${uploadedCount + 1}-${uploadedCount + currentBatch.length}/${sortedFileList.length}）`,
          completed: uploadedCount,
          total: sortedFileList.length,
        })

        const { assets } = await api.uploadEvidenceSourceFiles(currentBatch)
        const uploadedAssetMap = new Map<string, {
          storageKey: string
          contentHash: string
          storageUrl: string
          sourceMimeType?: string
        }>()
        assets.forEach((asset) => {
          uploadedAssetMap.set(
            normalizeRelativePath(asset.relativePath, asset.fileName).toLowerCase(),
            {
              storageKey: asset.storageKey,
              contentHash: asset.contentHash,
              storageUrl: asset.storageUrl,
              sourceMimeType: asset.sourceMimeType,
            },
          )
        })

        const files = currentBatch.map((sourceFile) => {
          const type = getEvidenceType(sourceFile.name.toLowerCase(), sourceFile.type)
          const relativePath = getRelativePathFromFile(sourceFile)
          const sourceMimeType = getSourceMimeType(sourceFile.name.toLowerCase(), sourceFile.type, type)
          const assetKey = normalizeRelativePath(relativePath, sourceFile.name).toLowerCase()
          const storedAsset = uploadedAssetMap.get(assetKey)
          if (!storedAsset) {
            throw new Error(`文件“${sourceFile.name}”接入失败，请重新导入。`)
          }

          return {
            fileName: sourceFile.name,
            relativePath,
            name: buildNormalizedEvidenceName(sourceFile.name, relativePath),
            type,
            ocrText: buildOcrPlaceholder(sourceFile.name, type),
            storageKey: storedAsset.storageKey,
            contentHash: storedAsset.contentHash,
            storageUrl: storedAsset.storageUrl,
            sourceMimeType: storedAsset.sourceMimeType || sourceMimeType,
            pages: type === 'pdf' ? 1 : 1,
            anchorHint: type === 'image' ? '图片框选区域' : type === 'pdf' ? '第 1 页' : '段落 1',
            summaryStatus: 'idle' as const,
          }
        })

        const { workspace } = await api.importEvidences({
          caseId: selectedCase.id,
          processInBackground: false,
          deferUnderstanding: true,
          files,
        })
        latestWorkspace = workspace
        uploadedCount += currentBatch.length
        currentBatch = []
        currentBatchBytes = 0

        applyWorkspace(workspace, {
          selectedCaseId: selectedCase.id,
          selectedCertificateId: null,
          activeParagraphId: null,
          selectedEvidenceIds,
        }, {
          preserveManualPreview: true,
        })

        setEvidenceImportProgress({
          stage: 'parse',
          message: `已接入 ${uploadedCount}/${sortedFileList.length} 个原件`,
          completed: uploadedCount,
          total: sortedFileList.length,
        })
      }

      for (const [index, file] of sortedFileList.entries()) {
        if (
          currentBatch.length
          && (
            currentBatch.length >= MAX_EVIDENCE_SOURCE_UPLOAD_BATCH_COUNT
            || currentBatchBytes + file.size > MAX_EVIDENCE_SOURCE_UPLOAD_BATCH_BYTES
          )
        ) {
          await flushCurrentBatch()
          await yieldWhenBusy(loopState)
        }

        currentBatch.push(file)
        currentBatchBytes += file.size

        if (shouldFlushProgress(loopState, index === sortedFileList.length - 1)) {
          setEvidenceImportProgress({
            stage: 'parse',
            message: `正在链接资料 ${index + 1}/${sortedFileList.length}`,
            completed: index + 1,
            total: sortedFileList.length,
          })
        }
        await yieldWhenBusy(loopState)
      }

      await flushCurrentBatch()

      setEvidenceImportProgress(null)

      if (!latestWorkspace) {
        return
      }

      const importedWorkspace: AppState = latestWorkspace

      applyWorkspace(importedWorkspace, {
        selectedCaseId: selectedCase.id,
        selectedCertificateId: null,
        activeParagraphId: null,
        selectedEvidenceIds: importedWorkspace.evidences
          .filter((item) => item.caseId === selectedCase.id)
          .map((item) => item.id),
      })
      setEvidenceImportResult({
        caseId: selectedCase.id,
        message: `已链接 ${sortedFileList.length} 个文件，可预览原件`,
      })
      const { workspace: queuedWorkspace } = await api.retryCaseAgent(selectedCase.id)
      applyWorkspace(queuedWorkspace, { selectedCaseId: selectedCase.id }, { preserveManualPreview: true })
      if (entryOnboardingStep === 'link-folder') {
        setEntryOnboardingStep('idle')
      }
    } finally {
      setPendingCaseEvidences([])
      setEvidenceImportProgress(null)
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target
    const allFiles = Array.from(input.files ?? []) as Array<File & { webkitRelativePath?: string }>
    const fileList = allFiles.filter(file => getEvidenceType(file.name.toLowerCase(), file.type) !== 'other')

    if (!selectedCase || !fileList.length) {
      return
    }

    input.value = ''

    setEvidenceImportProgress({
      stage: 'scan',
      message: `已读取 ${fileList.length} 个文件，准备解析`,
      completed: fileList.length,
      total: fileList.length,
    })

    await runMutation(async () => {
      await importEvidenceFiles(fileList)
    })
  }

  async function handleLinkFolder(retryDirectory?: CaseDirectoryManifest) {
    if (!selectedCase || isSubmitting || evidenceImportProgress || directoryPreparation) {
      return
    }
    setEvidenceImportResult(null)
    if (window.lawVerifyDesktop?.linkCaseDirectory) {
      setIsSubmitting(true)
      setDirectoryImportRetry(null)
      let directory = retryDirectory
      let linked = false
      let unsubscribe: (() => void) | undefined
      try {
          const account = loginAccount.trim().toLowerCase()
          const requestId = crypto.randomUUID()
          const showFiles = (manifest: CaseDirectoryManifest, append: boolean) => {
            if (sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY)?.trim().toLowerCase() !== account) return
            const timestamp = new Date().toISOString()
            const items: Evidence[] = manifest.files.map(item => ({
              id: `directory-pending:${manifest.id}:${item.relativePath}`,
              caseId: selectedCase.id, directoryId: manifest.id, number: '',
              name: item.fileName, fileName: item.fileName,
              relativePath: `${manifest.name}--${manifest.id}/${item.relativePath}`,
              sourceFingerprint: item.hash, type: getEvidenceType(item.fileName.toLowerCase(), ''),
              ocrText: '', uploadedAt: timestamp, summaryStatus: 'idle',
            }))
            const previous = streamedDirectoryEvidencesRef.current
              .filter(e => append || e.directoryId !== manifest.id)
            const byPath = new Map(previous.map(e => [e.relativePath, e]))
            items.forEach(e => byPath.set(e.relativePath, e))
            streamedDirectoryEvidencesRef.current = [...byPath.values()]
            setPendingCaseEvidences(streamedDirectoryEvidencesRef.current)
          }
          if (!retryDirectory) unsubscribe = window.lawVerifyDesktop!.onCaseDirectoryBatch?.(batch => {
            if (batch.requestId !== requestId || batch.caseId !== selectedCase.id || batch.account !== account
              || sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY)?.trim().toLowerCase() !== account) return
            showFiles(batch, true)
            setEvidenceImportProgress({
              stage: 'scan', message: `已发现 ${batch.completed} 个文件`, completed: batch.completed, total: 0,
            })
          })
          directory = retryDirectory ?? await window.lawVerifyDesktop!.linkCaseDirectory!({ account, caseId: selectedCase.id, requestId }) ?? undefined
          unsubscribe?.()
          unsubscribe = undefined
          if (!directory) return
          resumeCaseDirectorySync(account, selectedCase.id)
          showFiles(directory, false)
          setEvidenceImportProgress(null)
          setEvidenceImportResult({
            caseId: selectedCase.id, message: `已链接 ${directory.files.length} 个文件，可预览原件`,
          })
          setEntryOnboardingStep('idle')
          const authorized = () => sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY)?.trim().toLowerCase() === account
          const workspace = await syncDesktopDirectory(account, selectedCase.id, directory, authorized, (completed, total) => {
            if (!authorized()) return
            setDirectoryPreparation({ caseId: selectedCase.id, completed, total })
          }, linkedWorkspace => {
            if (!authorized()) return
            linked = true
            applyWorkspace(linkedWorkspace, { selectedCaseId: selectedCase.id }, { preserveManualPreview: true })
            streamedDirectoryEvidencesRef.current = streamedDirectoryEvidencesRef.current.filter(e =>
              e.directoryId !== directory!.id,
            )
            setPendingCaseEvidences(streamedDirectoryEvidencesRef.current)
            setEvidenceImportProgress(null)
            setIsSubmitting(false)
            setEntryOnboardingStep('idle')
            setEvidenceImportResult({
              caseId: selectedCase.id,
              message: `已链接 ${directory!.files.length} 个文件，可预览原件`,
            })
          })
          if (!authorized()) return
          applyWorkspace(workspace, { selectedCaseId: selectedCase.id }, { preserveManualPreview: true })
          setEvidenceImportResult({
            caseId: selectedCase.id,
            message: directory.files.length
              ? `已链接 ${directory.files.length} 个文件，可预览原件`
              : '文件夹内暂无可导入的资料',
          })
          setEntryOnboardingStep('idle')
      } catch (error) {
        const message = '材料接入暂时中断，请重试。'
        if (directory) setDirectoryImportRetry({ caseId: selectedCase.id, directory, message })
        setErrorMessage(error instanceof Error ? error.message : message)
      } finally {
        unsubscribe?.()
        setEvidenceImportProgress(null)
        setDirectoryPreparation(current => current?.caseId === selectedCase.id ? null : current)
        if (!linked) setIsSubmitting(false)
      }
      return
    }

    const pickerWindow = window as Window & {
      showDirectoryPicker?: () => Promise<DirectoryPickerDirectoryHandle>
    }

    if (!pickerWindow.showDirectoryPicker) {
      folderUploadRef.current?.click()
      return
    }

    try {
      const directoryHandle = await pickerWindow.showDirectoryPicker()
      setEvidenceImportProgress({
        stage: 'scan',
        message: `正在扫描目录 ${directoryHandle.name}`,
        completed: 0,
        total: 0,
      })
      const files = await collectFilesFromDirectoryHandle(directoryHandle, directoryHandle.name, (progress) => {
        setEvidenceImportProgress(progress)
      })

      if (!files.length) {
        throw new Error('所选文件夹内没有可导入文件。')
      }

      await runMutation(async () => {
        await importEvidenceFiles(files)
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setEvidenceImportProgress(null)
        return
      }

      setEvidenceImportProgress(null)
      setErrorMessage(error instanceof Error ? error.message : '链接文件夹失败')
      window.alert(error instanceof Error ? error.message : '链接文件夹失败')
    }
  }

  async function handleClearFolderLinks() {
    if (!selectedCase || isSubmitting || evidenceImportProgress || directoryPreparation) return
    if (!window.confirm('清除本案全部文件夹链接及证据列表？相关证据引用和理解结果也会清除，文书正文及电脑上的原始文件不会删除。')) return
    const caseId = selectedCase.id
    await runMutation(async () => {
      const account = loginAccount.trim().toLowerCase()
      await stopCaseDirectorySync(account, caseId)
      await window.lawVerifyDesktop?.clearCaseDirectories?.({ account, caseId })
      const { workspace } = await api.clearCaseDirectoryEvidences(caseId)
      streamedDirectoryEvidencesRef.current = streamedDirectoryEvidencesRef.current.filter(e => e.caseId !== caseId)
      setPendingCaseEvidences(current => current.filter(e => e.caseId !== caseId))
      setManualPreviewEvidenceId(null)
      setImageViewerState(null)
      clearLocalPreviewSourceMap()
      setDirectoryImportRetry(null)
      setDirectoryPreparation(null)
      applyWorkspace(workspace, { selectedCaseId: caseId, selectedEvidenceIds: [] })
      setEvidenceImportResult({ caseId, message: '已清除文件夹链接' })
    })
  }

  function handleCloseRechargeDialog() {
    setRechargeDialogState(null)
  }

  function handleOpenFeedbackDialog() {
    if (!cloudAuthToken?.trim()) {
      window.alert('请先登录官网账户后，再提交用户反馈。')
      return
    }

    setFeedbackDialogState({
      feedbackType: 'bug',
      title: '',
      content: '',
      contact: appState?.user.email?.trim() || loginAccount.trim(),
    })
  }

  function handleCloseFeedbackDialog() {
    if (isSubmitting) {
      return
    }

    setFeedbackDialogState(null)
  }

  async function handleRecharge() {
    await runMutation(async () => {
      if (!cloudAuthToken?.trim()) {
        throw new Error('当前桌面端尚未同步到账户中心登录态，请重新登录后再试。')
      }

      await openExternalUrl(getAccountCenterBillingUrl(cloudAuthToken))
    })
  }

  async function handleSubmitFeedback() {
    if (!feedbackDialogState) {
      return
    }

    const title = feedbackDialogState.title.trim()
    const content = feedbackDialogState.content.trim()
    if (!title) {
      window.alert('请先填写反馈标题。')
      return
    }
    if (content.length < 10) {
      window.alert('请尽量详细描述问题或建议，至少填写 10 个字。')
      return
    }

    await runMutation(async () => {
      if (!cloudAuthToken?.trim()) {
        throw new Error('当前桌面端尚未同步到账户中心登录态，请重新登录后再试。')
      }

      const pageContext = activeTab === 'workspace' ? `workspace/${caseCenterTab}` : activeTab
      const platformLabel = window.lawVerifyDesktop?.channel === 'electron'
        ? `electron / ${navigator.platform || 'unknown'}`
        : (navigator.userAgent || 'browser')

      await api.submitCloudFeedback({
        feedbackType: feedbackDialogState.feedbackType,
        title,
        content,
        contact: feedbackDialogState.contact.trim(),
        appVersion: __APP_VERSION__,
        clientPlatform: platformLabel,
        pageContext,
        caseName: selectedCase?.name ?? '',
      })

      setFeedbackDialogState(null)
      window.alert('反馈已提交，我们会在管理员后台统一查看与跟进。')
    })
  }

  async function handleSelectRechargeOrder(order: RechargeOrder) {
    const qrCodeDataUrl = order.qrCodeContent?.trim()
      ? await QRCode.toDataURL(order.qrCodeContent, {
          margin: 1,
          width: 280,
        })
      : ''

    setRechargeDialogState((current) => current
      ? {
          ...current,
          activeOrder: order,
          qrCodeDataUrl,
        }
      : current)
  }

  async function refreshRechargeOrder(orderId: string, silent = false) {
    try {
      const { workspace, order } = await api.getRechargeOrder(orderId)
      applyWorkspace(workspace, {
        selectedCaseId,
        selectedCertificateId,
        activeParagraphId,
        selectedEvidenceIds,
      })

      let qrCodeDataUrl = ''
      if (order.qrCodeContent?.trim()) {
        qrCodeDataUrl = await QRCode.toDataURL(order.qrCodeContent, {
          margin: 1,
          width: 280,
        })
      }

      setRechargeDialogState((current) => current
        ? {
            ...current,
            activeOrder: order,
            qrCodeDataUrl,
          }
        : current)

      return order
    } catch (error) {
      if (!silent) {
        throw error
      }

      return null
    }
  }

  async function handleCreateRechargeOrder() {
    if (!rechargeDialogState?.selectedPackageId) {
      window.alert('请先选择充值套餐。')
      return
    }

    await runMutation(async () => {
      const { workspace, order, providers, packages } = await api.createRechargeOrder({
        channel: rechargeDialogState.selectedChannel,
        packageId: rechargeDialogState.selectedPackageId!,
      })

      applyWorkspace(workspace, {
        selectedCaseId,
        selectedCertificateId,
        activeParagraphId,
        selectedEvidenceIds,
      })

      const qrCodeDataUrl = order.qrCodeContent?.trim()
        ? await QRCode.toDataURL(order.qrCodeContent, {
            margin: 1,
            width: 280,
          })
        : ''

      setRechargeDialogState((current) => current
        ? {
            ...current,
            providers,
            packages,
            activeOrder: order,
            qrCodeDataUrl,
          }
        : current)
    })
  }

  function openKnowledgeLibraryModule(_tab: SettingsTab, _documentId?: string | null, _articleId?: string | null) {
    setActiveTab('settings')
    setSettingsTab('files')
    setSettingsKnowledgeFileKeyword('')
    setSettingsStatuteKeyword('')
    setSettingsSelectedStatuteId(null)
    setSettingsSelectedArticleId(null)

    if (streamlinedMode) {
      setIsKnowledgeLibraryDialogOpen(true)
    }
  }

  function handleOpenStatuteSettings(_documentId?: string | null, _articleId?: string | null) {
    openKnowledgeLibraryModule('files')
  }

  function handleCloseKnowledgeLibraryDialog() {
    setIsKnowledgeLibraryDialogOpen(false)
  }

  async function handleUpdateEvidence(evidenceId: string, patch: Record<string, unknown>) {
    await runMutation(async () => {
      const { workspace } = await api.updateEvidence(evidenceId, patch)
      applyWorkspace(workspace, { selectedCaseId, selectedEvidenceIds })
    })
  }

  function getEstimatedActionPoints(actionType: ChargeablePointAction) {
    return pointPolicyMap[actionType] ?? DEFAULT_POINT_POLICY_MAP[actionType]
  }

  async function runChargeableAction<T>(
    config: {
      actionType: ChargeablePointAction
      units?: number
      resourceType: string
      resourceId?: string
      note: string
    },
    task: () => Promise<T>,
  ) {
    if (!cloudAuthToken?.trim()) {
      throw new Error('当前桌面端尚未绑定官网账户，请使用官网已注册邮箱登录后再执行扣费功能。')
    }
    if (appState?.aiBillingMode === 'cloud') {
      try { return await task() } finally { void syncCloudPoints() }
    }

    const idempotencyKey = createPointOperationKey(config.actionType, config.resourceId)
    const consumeResult = await api.consumeCloudPointAction({
      actionType: config.actionType,
      units: config.units,
      idempotencyKey,
      workspaceId: selectedCaseId ?? undefined,
      resourceType: config.resourceType,
      resourceId: config.resourceId,
      note: config.note,
    })

    updateCloudPointLedgerPreview(consumeResult.entry, consumeResult.pointsBalance)

    try {
      const result = await task()
      void syncCloudPoints()

      if (consumeResult.pointsBalance <= 0) {
        window.alert('当前积分已耗尽，本次任务完成后将无法继续使用 AI 功能，请及时充值。')
      }

      return result
    } catch (error) {
      try {
        const refundResult = await api.refundCloudPointAction({
          refundOperationKey: `${idempotencyKey}:refund`,
          sourceEntryId: consumeResult.entry.id,
          note: `${consumeResult.entry.description}失败补回`,
        })
        updateCloudPointLedgerPreview(refundResult.entry, refundResult.pointsBalance)
      } catch {
        void syncCloudPoints()
      }

      throw error
    }
  }

  async function handleSummarizeEvidence(
    evidenceId: string,
    options: {
      silent?: boolean
      force?: boolean
    } = {},
  ) {
    const { silent = false, force = false } = options

    try {
      const evidence = appState?.evidences.find((item) => item.id === evidenceId)
      if (!evidence || evidence.directoryId && !evidence.storageKey) return
      const hasLocalSummary = evidence?.summaryStatus === 'ready' && Boolean(evidence.summaryText?.trim())

      if (!force && hasLocalSummary) {
        return
      }

      setSummarizingEvidenceId(evidenceId)

      if (!force) {
        const cacheProbe = await api.summarizeEvidence(evidenceId, { cacheOnly: true })
        applyWorkspace(cacheProbe.workspace, {
          selectedCaseId,
          selectedCertificateId,
          activeParagraphId,
          selectedEvidenceIds,
        }, {
          preserveManualPreview: true,
        })

        if (cacheProbe.reusedCachedSummary || cacheProbe.processing) {
          return
        }
      }

      const { workspace } = await runChargeableAction({
        actionType: 'evidence_summary',
        resourceType: 'evidence',
        resourceId: evidenceId,
        note: evidence ? `证据摘要：${evidence.number} ${evidence.name}` : '证据摘要消耗',
      }, () => api.summarizeEvidence(evidenceId, force ? { force: true } : undefined))

      applyWorkspace(workspace, {
        selectedCaseId,
        selectedCertificateId,
        activeParagraphId,
        selectedEvidenceIds,
      }, {
        preserveManualPreview: true,
      })
    } catch (error) {
      if (!silent) {
        const message = error instanceof Error ? error.message : 'AI 理解原材料失败'
        setErrorMessage(message)
        window.alert(message)
      }
    } finally {
      setSummarizingEvidenceId((current) => (current === evidenceId ? null : current))
    }
  }

  async function handleDeleteEvidence(evidenceId: string) {
    await runMutation(async () => {
      const { workspace } = await api.deleteEvidence(evidenceId)
      applyWorkspace(workspace, {
        selectedCaseId,
        selectedCertificateId,
        activeParagraphId,
        selectedEvidenceIds: selectedEvidenceIds.filter((item) => item !== evidenceId),
      })
    })
  }

  function handleStartWorkbenchResize(event: React.PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 1280) {
      return
    }

    workbenchResizeRef.current = {
      startX: event.clientX,
      startWidth: insightPanelWidth,
    }
    setIsResizingWorkbench(true)
    event.preventDefault()
  }

  function handleStartStreamlinedSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 1024) {
      return
    }

    streamlinedSidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: isStreamlinedSidebarCollapsed
        ? COLLAPSED_STREAMLINED_SIDEBAR_WIDTH
        : streamlinedSidebarWidth,
    }
    setIsResizingStreamlinedSidebar(true)
    event.preventDefault()
  }

  function handleStartKnowledgeFilesSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 960) {
      return
    }

    knowledgeFilesSidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: knowledgeFilesSidebarWidth,
    }
    setIsResizingKnowledgeFilesSidebar(true)
    event.preventDefault()
  }

  function handleToggleStreamlinedSidebar() {
    if (isStreamlinedSidebarCollapsed) {
      setStreamlinedSidebarWidth((current) => Math.max(current, DEFAULT_STREAMLINED_SIDEBAR_WIDTH))
    }
    setIsStreamlinedSidebarCollapsed(current => !current)
  }

  function handleIdeNavigation(target: IdeNavigationTarget) {
    setIsIdeAccountOpen(false)
    if (target !== 'knowledge') setIsKnowledgeLibraryDialogOpen(false)
    if (target === 'files') {
      handleToggleStreamlinedSidebar()
    } else if (target === 'document') {
      setIdeContentTab('document')
    } else if (target === 'assistant') {
      setIsIdeAssistantVisible(true)
      setAgentMode('case')
    } else {
      setSettingsTab('files')
      setIsKnowledgeLibraryDialogOpen(true)
    }
    setIdeNavigationRequest({ target })
  }

  useEffect(() => {
    if (!ideNavigationRequest) return
    // Also give already-open panels a visible destination without focusing the editor
    // and changing its sentence selection or triggering an automatic save.
    const frame = window.requestAnimationFrame(() => {
      const { target } = ideNavigationRequest
      const selector = target === 'files' ? '.streamlined-sidebar'
        : target === 'document' ? '.ide-document-view'
          : target === 'assistant' ? '.ide-assistant-view' : '.knowledge-library-dialog'
      const panel = streamlinedShellRef.current?.querySelector<HTMLElement>(selector)
      if (!panel || panel.hidden) return
      panel.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [ideNavigationRequest])

  function handleResetStreamlinedSidebarWidth() {
    setStreamlinedSidebarWidth(DEFAULT_STREAMLINED_SIDEBAR_WIDTH)
    setIsStreamlinedSidebarCollapsed(false)
  }

  async function handleGenerateCertificate() {
    if (!selectedCase) {
      return
    }

    await runMutation(async () => {
      const trimmedPrompt = agentPromptRef.current.trim()
      const selectedEvidenceCount = selectedEvidenceIds.length
      const selectedEvidenceLabel = selectedEvidenceCount
        ? `（已选 ${selectedEvidenceCount} 份证据）`
        : ''

      openCaseCenter('draft')
      setIdeContentTab('document')
      setIsAgentWindowOpen(false)
      setStreamingCertificatePreview({
        mode: 'generate',
        title: '正在生成法律文书...',
        focus: trimmedPrompt || DEFAULT_GENERATION_FOCUS,
        createdAt: new Date().toISOString(),
        paragraphs: [],
      })

      let completed = false

      try {
        await runChargeableAction({
          actionType: 'pleading_full',
          resourceType: 'case',
          resourceId: selectedCase.id,
          note: `整文生成：${selectedCase.name}${selectedEvidenceLabel}`,
        }, () => api.generateCertificateStream({
          caseId: selectedCase.id,
          evidenceIds: selectedEvidenceIds,
          role: selectedCase.agent?.position?.role === 'defendant' ? 'defendant' : DEFAULT_GENERATION_ROLE,
          focus: trimmedPrompt || DEFAULT_GENERATION_FOCUS,
          prompt: trimmedPrompt || undefined,
        }, {
          onMeta: (event) => {
            setStreamingCertificatePreview((current) => current ? {
              ...current,
              title: event.title || current.title,
              focus: event.focus || current.focus,
            } : current)
          },
          onParagraph: (event) => {
            setStreamingCertificatePreview((current) => {
              if (!current) {
                return current
              }

              const nextParagraphs = [...current.paragraphs]
              nextParagraphs[event.index] = {
                id: `streaming-paragraph-${event.index + 1}`,
                text: event.text,
              }

              return {
                ...current,
                paragraphs: nextParagraphs,
              }
            })
          },
          onDone: ({ workspace, certificate, agentReply }) => {
            completed = true
            if (trimmedPrompt) {
              setAgentMessages((current) => [
                ...current,
                {
                  id: `user-${Date.now()}`,
                  role: 'user',
                  content: trimmedPrompt,
                },
                {
                  id: `assistant-${Date.now() + 1}`,
                  role: 'assistant',
                  content: agentReply
                    || (certificate.title
                      ? `已根据你的要求生成《${certificate.title}》。${certificate.focus ? `本版焦点：${certificate.focus}。` : ''}`
                      : '已根据你的要求生成一版文书草稿。'),
                },
              ])
            }

            applyWorkspace(workspace, {
              selectedCaseId: selectedCase.id,
              selectedCertificateId: certificate.id,
              activeParagraphId: certificate.paragraphs[0]?.id ?? null,
              selectedEvidenceIds,
            })
            setStreamingCertificatePreview(null)
            setAgentPrompt('')
          },
        }))
      } finally {
        if (!completed) {
          setStreamingCertificatePreview(null)
        }
      }
    })
  }

  async function handleRewriteCertificate() {
    if (!activeCertificate) {
      return
    }

    await runMutation(async () => {
      const trimmedPrompt = agentPromptRef.current.trim()
      if (!trimmedPrompt) {
        throw new Error('请先输入继续追问或改写要求。')
      }

      const rewriteEvidenceIds = selectedEvidenceIds.length ? selectedEvidenceIds : activeCertificateEvidenceIds
      openCaseCenter('draft')
      setIdeContentTab('document')
      setIsAgentWindowOpen(false)
      setStreamingCertificatePreview({
        mode: 'rewrite',
        title: activeCertificate.title || '正在改写当前文书...',
        focus: activeCertificate.focus || DEFAULT_GENERATION_FOCUS,
        createdAt: activeCertificate.createdAt,
        paragraphs: [],
      })

      let completed = false

      try {
        await runChargeableAction({
          actionType: 'pleading_full',
          resourceType: 'certificate',
          resourceId: activeCertificate.id,
          note: `整文改写：${activeCertificate.title}`,
        }, () => api.rewriteCertificateStream({
          certificateId: activeCertificate.id,
          evidenceIds: rewriteEvidenceIds,
          prompt: trimmedPrompt,
        }, {
          onMeta: (event) => {
            setStreamingCertificatePreview((current) => current ? {
              ...current,
              title: event.title || current.title,
              focus: event.focus || current.focus,
            } : current)
          },
          onParagraph: (event) => {
            setStreamingCertificatePreview((current) => {
              if (!current) {
                return current
              }

              const nextParagraphs = [...current.paragraphs]
              nextParagraphs[event.index] = {
                id: `streaming-paragraph-${event.index + 1}`,
                text: event.text,
              }

              return {
                ...current,
                paragraphs: nextParagraphs,
              }
            })
          },
          onDone: ({ workspace, certificate, agentReply }) => {
            completed = true
            setAgentMessages((current) => [
              ...current,
              {
                id: `user-${Date.now()}`,
                role: 'user',
                content: trimmedPrompt,
              },
              {
                id: `assistant-${Date.now() + 1}`,
                role: 'assistant',
                content: agentReply
                  || `已按你的追问改写当前草稿《${certificate.title}》，并尽量保留段落对应的证据来源。`,
              },
            ])

            applyWorkspace(workspace, {
              selectedCaseId: selectedCase?.id ?? activeCertificate.caseId,
              selectedCertificateId: certificate.id,
              activeParagraphId: certificate.paragraphs[0]?.id ?? activeParagraph?.id ?? null,
              selectedEvidenceIds: rewriteEvidenceIds,
            })
            setStreamingCertificatePreview(null)
            setAgentPrompt('')
          },
        }))
      } finally {
        if (!completed) {
          setStreamingCertificatePreview(null)
        }
      }
    })
  }

  async function readImportedCertificateContent(file: File) {
    const lowerName = file.name.toLowerCase()
    if (file.size > 20 * 1024 * 1024) throw new Error('文稿超过20MB，请拆分后导入。')

    if (lowerName.endsWith('.docx')) {
      const result = await importWordContent(file)

      return {
        content: result.text.trim(),
        paragraphs: buildImportedParagraphDraftsFromHtml(result.html),
      }
    }

    if (lowerName.endsWith('.txt') || lowerName.endsWith('.md')) {
      const content = (await file.text()).trim()
      return {
        content,
        paragraphs: content
          .split(/\n\s*\n+/)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((text) => ({
            text,
            richText: buildParagraphRichText(text),
          })),
      }
    }

    if (lowerName.endsWith('.rtf')) {
      const content = stripRtfControlText(await file.text())
      return {
        content,
        paragraphs: content
          .split(/\n\s*\n+/)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((text) => ({
            text,
            richText: buildParagraphRichText(text),
          })),
      }
    }

    if (lowerName.endsWith('.doc') || lowerName.endsWith('.wps')) {
      throw new Error('当前支持直接导入 .docx / .rtf / .txt / .md；.doc / .wps 请先另存为 .docx 后再上传。')
    }

    throw new Error('仅支持导入 Word 兼容文书：.docx / .doc / .rtf / .txt / .md / .wps')
  }

  async function handleUploadCertificate(file: File) {
    if (!selectedCase) {
      return
    }

    await runMutation(async () => {
      const imported = await readImportedCertificateContent(file)

      if (!imported.content.trim()) {
        throw new Error('上传文书未解析出正文内容。')
      }

      const { workspace, certificate } = await api.importCertificate({
        caseId: selectedCase.id,
        title: file.name.replace(/\.[^.]+$/, ''),
        content: imported.content,
        sourceFileName: file.name,
        paragraphs: imported.paragraphs,
      })

      applyWorkspace(workspace, {
        selectedCaseId: selectedCase.id,
        selectedCertificateId: certificate.id,
        activeParagraphId: certificate.paragraphs[0]?.id ?? null,
        selectedEvidenceIds,
      })
    })
  }

  async function handleCertificateUploadInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    await handleUploadCertificate(file)
  }

  async function handleKnowledgeFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''

    if (!files.length) {
      return
    }

    try {
      await importKnowledgeFilesIntoLibrary(files)
    } catch (error) {
      const message = error instanceof Error ? error.message : '知识文件上传失败'
      setErrorMessage(message)
      window.alert(message)
    }
  }

  async function importKnowledgeFilesIntoLibrary(files: File[], source: KnowledgeUploadProgress['source'] = 'file') {
    const supportedFiles = files.filter((file) => isSupportedKnowledgeImportFile(file.name))

    if (!supportedFiles.length) {
      throw new Error('当前未发现可导入的知识文件，请选择 Word、PDF、RTF、TXT、Markdown 或 WPS 文件。')
    }

    clearKnowledgeUploadTimers()
    setKnowledgeUploadProgress({
      stage: 'prepare',
      message: `已接收 ${supportedFiles.length} 个${source === 'folder' ? '文件夹内' : ''}文件，正在检查格式并准备上传。`,
      fileNames: supportedFiles.map((file) => file.name),
      total: supportedFiles.length,
      source,
    })
    queueKnowledgeUploadStage('upload', 160, `正在上传 ${supportedFiles.length} 个文件到知识库，请稍候。`)
    queueKnowledgeUploadStage('extract', 1100, '文件已上传，正在等待服务端完成正文抽取与向量化入库。')

    try {
      await runMutation(async () => {
        const { workspace, files: uploadedFiles } = await api.uploadKnowledgeFiles(supportedFiles)
        applyWorkspaceWithKnowledgeFiles(workspace, uploadedFiles)
        const importedFile =
          uploadedFiles[0]
          ?? workspace.knowledgeFiles[0]
          ?? null
        setSettingsTab('files')
        setSettingsSelectedKnowledgeFileId(importedFile?.id ?? null)
        clearKnowledgeUploadTimers()
        setKnowledgeUploadProgress((current) => ({
          stage: 'complete',
          message: `已完成 ${uploadedFiles.length || supportedFiles.length} 个文件的上传，当前可在右侧查看抽取和向量化结果。`,
          fileNames: current?.fileNames ?? supportedFiles.map((file) => file.name),
          total: uploadedFiles.length || supportedFiles.length,
          source: current?.source ?? source,
        }))
        scheduleKnowledgeUploadClear()
      })
    } catch (error) {
      clearKnowledgeUploadTimers()
      setKnowledgeUploadProgress({
        stage: 'failed',
        message: error instanceof Error ? error.message : '知识文件上传失败，请稍后重试。',
        fileNames: supportedFiles.map((file) => file.name),
        total: supportedFiles.length,
        source,
      })
      scheduleKnowledgeUploadClear(4800)
      throw error
    }
  }

  async function handleKnowledgeFolderUpload(event: ChangeEvent<HTMLInputElement>) {
    const allFiles = Array.from(event.target.files ?? [])
    const files = allFiles.filter(file => getEvidenceType(file.name.toLowerCase(), file.type) !== 'other')
    event.target.value = ''

    if (!files.length) {
      return
    }

    try {
      await importKnowledgeFilesIntoLibrary(files, 'folder')
    } catch (error) {
      const message = error instanceof Error ? error.message : '知识文件夹导入失败'
      setErrorMessage(message)
      window.alert(message)
    }
  }

  async function handleLinkKnowledgeFolder() {
    const pickerWindow = window as Window & {
      showDirectoryPicker?: () => Promise<DirectoryPickerDirectoryHandle>
    }

    if (!pickerWindow.showDirectoryPicker) {
      knowledgeFolderUploadRef.current?.click()
      return
    }

    try {
      const directoryHandle = await pickerWindow.showDirectoryPicker()
      const files = await collectFilesFromDirectoryHandle(directoryHandle, directoryHandle.name)

      if (!files.length) {
        throw new Error('所选文件夹内没有可导入的文件。')
      }

      await importKnowledgeFilesIntoLibrary(files, 'folder')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }

      const message = error instanceof Error ? error.message : '知识文件夹导入失败'
      setErrorMessage(message)
      window.alert(message)
    }
  }

  async function handleReindexKnowledgeFile(file: KnowledgeFileRecord) {
    const mode: KnowledgeReindexProgress['mode'] = file.extractedText.trim() ? 'vectorize' : 'reindex'
    clearKnowledgeReindexTimers(file.id)
    setKnowledgeReindexProgressByFileId((current) => ({
      ...current,
      [file.id]: {
        stage: 'prepare',
        fileId: file.id,
        fileName: file.fileName,
        mode,
        message: mode === 'vectorize'
          ? '已收到重新向量化请求，正在准备读取当前正文并重建索引。'
          : '已收到重新处理请求，正在读取原始文件并准备重新抽取正文。',
      },
    }))
    queueKnowledgeReindexStage(
      file.id,
      'extract',
      180,
      mode === 'vectorize'
        ? '正在根据当前正文重建向量索引，请稍候。'
        : '正在重新抽取正文并同步更新向量索引，请稍候。',
    )

    try {
      await runMutation(async () => {
        const { workspace, file: updatedFile } = await api.reindexKnowledgeFile(file.id)
        applyWorkspaceWithKnowledgeFiles(workspace, updatedFile ? [updatedFile] : [])
        clearKnowledgeReindexTimers(file.id)
        setKnowledgeReindexProgressByFileId((current) => ({
          ...current,
          [file.id]: {
            stage: 'complete',
            fileId: file.id,
            fileName: file.fileName,
            mode,
            message: mode === 'vectorize'
              ? '当前文件的向量索引已重建完成。'
              : '当前文件已重新处理完成，正文抽取和向量索引已更新。',
          },
        }))
        scheduleKnowledgeReindexClear(file.id)
      })
    } catch (error) {
      clearKnowledgeReindexTimers(file.id)
      setKnowledgeReindexProgressByFileId((current) => ({
        ...current,
        [file.id]: {
          stage: 'failed',
          fileId: file.id,
          fileName: file.fileName,
          mode,
          message: error instanceof Error ? error.message : '重新处理失败，请稍后重试。',
        },
      }))
      scheduleKnowledgeReindexClear(file.id, 4800)
      throw error
    }
  }

  async function handleUpdateParagraphById(paragraphId: string, patch: Partial<CertificateParagraph>, quiet = false, expected?: { text: string; richText?: string }) {
    if (!activeCertificate) {
      return false
    }

    const account = sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY)
    const certificate = activeCertificate
    // Enqueue before awaiting so a following click cannot overtake the blur save.
    const saving = documentTaskQueueRef.current.run(async () => {
      if (sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY) !== account) throw new Error('Account changed')
      const { workspace } = await api.updateParagraph(certificate.id, paragraphId, patch, expected)
      if (sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY) !== account) throw new Error('Account changed')
      if (quiet) {
        backgroundWorkspaceHandler.current(workspace)
        return
      }
      applyWorkspace(workspace, {
        selectedCaseId: certificate.caseId,
        selectedCertificateId: certificate.id,
        activeParagraphId: paragraphId,
        selectedEvidenceIds,
      })
    })
    const saved = quiet
      ? await saving.then(() => true, () => false)
      : await runMutation(() => saving)
    if (!saved) documentTaskQueueRef.current.recover()
    return saved
  }

  async function handleUpdateParagraph(patch: Partial<CertificateParagraph>) {
    if (!activeParagraph) {
      return
    }

    await handleUpdateParagraphById(activeParagraph.id, patch)
  }

  async function handleAutoLinkCertificate() {
    if (!activeCertificate) {
      handleOpenEvidenceLinking()
      return
    }
    if (documentAnalysisRunningRef.current) return
    documentAnalysisRunningRef.current = true

    setAutoLinkFeedback({ tone: 'loading', text: '正在读取文书与案件材料' })
    setLockedPreviewEvidenceId(previewEvidence?.id ?? null)
    setAutoLinkingCertificateId(activeCertificate.id)
    try {
      const linking = documentTaskQueueRef.current.run(async () => {
        let result: Awaited<ReturnType<typeof api.autoLinkCertificate>>
        try {
          result = await api.autoLinkCertificate(activeCertificate.id, (text) => {
            setAutoLinkFeedback({ tone: 'loading', text })
          })
        } catch (error) {
          setAutoLinkFeedback({ tone: 'info', text: '本次联动未完成，请稍后重试。' })
          throw error
        }
        const { workspace } = result
        applyWorkspace(workspace, {
          selectedCaseId: activeCertificate.caseId,
          selectedCertificateId: activeCertificate.id,
          activeParagraphId: activeParagraph?.id ?? activeCertificate.paragraphs[0]?.id ?? null,
          selectedEvidenceIds,
        })

        const { linkedParagraphCount, evidenceLinkCount, statuteReferenceCount, caseReferenceCount } = result
        const totalMatches = evidenceLinkCount + statuteReferenceCount + caseReferenceCount
        setAutoLinkFeedback(
          totalMatches > 0
            ? {
              tone: 'success',
              text: `联动完成：已关联 ${linkedParagraphCount} 段关键内容，材料 ${evidenceLinkCount} 条、法条 ${statuteReferenceCount} 条、案例 ${caseReferenceCount} 条。`,
            }
            : {
              tone: 'info',
              text: '核验完成，本次未发现需要新增关联的关键内容。',
            },
        )
      })
      const linked = await runMutation(() => linking)
      if (linked) {
        openCaseCenter('review')
        setPreviewPanelMode('preview')
        revealInsightPanel()
      } else {
        documentTaskQueueRef.current.recover()
      }
    } finally {
      documentAnalysisRunningRef.current = false
      setLockedPreviewEvidenceId(null)
      setAutoLinkingCertificateId(null)
    }
  }

  function toggleEvidenceSelection(evidenceId: string) {
    setSelectedEvidenceIds((current) =>
      current.includes(evidenceId)
        ? current.filter((item) => item !== evidenceId)
        : [...current, evidenceId],
    )
  }

  async function handleUpdateActiveReference(patch: Partial<EvidenceLink>) {
    if (!activeParagraph || !activeLink) {
      return
    }

    const nextLinks = getParagraphLinks(activeParagraph).map((link, index) =>
      index === activeReferenceIndex ? { ...link, ...patch } : link,
    )

    await handleUpdateParagraph({
      links: nextLinks,
    })
  }

  async function handleBindStatute(article: KnowledgeStatuteArticle, document: KnowledgeStatuteDocument) {
    if (!activeParagraph) {
      return
    }

    const currentReferences = getParagraphReferences(activeParagraph)
    const exists = currentReferences.some((item) => item.type === 'statute' && item.targetId === article.id)

    if (exists) {
      const existing = currentReferences.find((item) => item.type === 'statute' && item.targetId === article.id)
      setSelectedKnowledgeReferenceId(existing ? getReferenceIdentity(existing) : null)
      setVerifyInsightTab('statute')
      return
    }

    await handleUpdateParagraph({
      references: [
        ...currentReferences,
        {
          id: `statute-${article.id}`,
          type: 'statute',
          targetId: article.id,
          sourceTitle: document.title,
          label: `${document.title} ${article.articleNumber}`,
          locator: article.articleNumber,
          quote: article.content,
          sentenceIndex: activeSentenceSelection.index ?? undefined,
          sentenceText: activeSentenceSelection.text || undefined,
        },
      ],
      verified: false,
    })

    setSelectedKnowledgeReferenceId(`statute-${article.id}`)
    setVerifyInsightTab('statute')
  }

  async function ensureKnowledgeCaseAvailable(entry: KnowledgeCase) {
    const exists = (appState?.knowledgeCases ?? []).some((item) => item.id === entry.id)
    if (exists) {
      return
    }

    const { workspace } = await api.importKnowledgeCases({
      items: [entry],
    })

    applyWorkspace(workspace, {
      selectedCaseId,
      selectedCertificateId,
      activeParagraphId,
      selectedEvidenceIds,
    })
  }

  async function handleOpenKnowledgeCaseDetail(entry: KnowledgeCase) {
    await ensureKnowledgeCaseAvailable(entry)
    setSelectedKnowledgeCaseId(entry.id)
    setActiveTab('knowledge')
    setKnowledgeTab('cases')
  }

  async function handleBindCaseExcerpt(excerpt: KnowledgeCaseExcerpt, entry: KnowledgeCase) {
    if (!activeParagraph) {
      return
    }

    await ensureKnowledgeCaseAvailable(entry)

    const currentReferences = getParagraphReferences(activeParagraph)
    const exists = currentReferences.some((item) => item.type === 'case' && item.targetId === excerpt.id)

    if (exists) {
      const existing = currentReferences.find((item) => item.type === 'case' && item.targetId === excerpt.id)
      setSelectedKnowledgeReferenceId(existing ? getReferenceIdentity(existing) : null)
      setVerifyInsightTab('case')
      return
    }

    await handleUpdateParagraph({
      references: [
        ...currentReferences,
        {
          id: `case-${excerpt.id}`,
          type: 'case',
          targetId: excerpt.id,
          sourceTitle: entry.title,
          label: `${entry.courtName} · ${entry.caseNumber}`,
          locator: excerpt.locator,
          quote: excerpt.content,
          sentenceIndex: activeSentenceSelection.index ?? undefined,
          sentenceText: activeSentenceSelection.text || undefined,
        },
      ],
      verified: false,
    })

    setSelectedKnowledgeReferenceId(`case-${excerpt.id}`)
    setVerifyInsightTab('case')
  }

  async function handleRemoveKnowledgeReference(referenceId: string) {
    if (!activeParagraph) {
      return
    }

    await handleUpdateParagraph({
      references: getParagraphReferences(activeParagraph).filter((item) => item.id !== referenceId),
      verified: false,
    })
  }

  function revealInsightPanel() {
    window.requestAnimationFrame(() => {
      evidenceColumnRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
        inline: 'nearest',
      })
    })
  }

  function handlePreviewEvidenceReference(paragraphId: string, linkIndex: number) {
    const paragraph = activeCertificate?.paragraphs.find((item) => item.id === paragraphId) ?? null
    const link = getParagraphLinks(paragraph)[linkIndex]
    focusParagraph(paragraphId, linkIndex)
    setManualPreviewEvidenceId(null)
    setImageViewerState(null)
    setVerifyInsightTab('evidence')
    setIdeContentTab('document')
    setIsIdeAssistantVisible(false)
    setPreviewPanelMode('preview')
    syncActiveSentence(paragraph, link)
    revealInsightPanel()
  }

  function handlePreviewEvidenceItem(evidence: Evidence) {
    setManualPreviewEvidenceId(evidence.id)
    setImageViewerState(null)
    setVerifyInsightTab('evidence')
    setIdeContentTab('evidence')
    setIsIdeAssistantVisible(false)
    setPreviewPanelMode('preview')
    revealInsightPanel()
    const previewKey = getEvidencePreviewSourceKey(evidence)
    if (evidence.directoryId && (evidence.sourceFingerprint || evidence.contentHash) && window.lawVerifyDesktop?.readCaseDirectoryFile
      && !localPreviewSourceMap[previewKey]) {
      const account = loginAccount.trim().toLowerCase()
      const relativePath = evidence.relativePath?.split('/').slice(1).join('/')
      if (relativePath) {
        void window.lawVerifyDesktop.readCaseDirectoryFile({
          account, caseId: evidence.caseId, directoryId: evidence.directoryId, relativePath, hash: evidence.sourceFingerprint || evidence.contentHash!,
        }).then(bytes => {
          if (sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY)?.trim().toLowerCase() !== account) return
          const type = getSourceMimeType(evidence.fileName.toLowerCase(), '', evidence.type)
          replaceLocalPreviewSourceMap({ [previewKey]: URL.createObjectURL(new Blob([bytes], { type })) })
        }).catch(() => setErrorMessage('原件暂时无法读取，请确认本地文件仍在原目录中。'))
      }
    }
  }

  function handleOpenImageViewer() {
    if (!previewEvidence || previewEvidence.type !== 'image' || !previewSource) {
      return
    }

    setImageViewerState({
      src: previewSource,
      title: previewEvidence.fileName,
      scale: 1,
    })
  }

  function updateImageViewerScale(nextScale: number) {
    setImageViewerState((current) => {
      if (!current) {
        return current
      }

      return {
        ...current,
        scale: Math.min(4, Math.max(0.5, Number(nextScale.toFixed(2)))),
      }
    })
  }

  function handlePreviewKnowledgeReference(paragraphId: string, reference: ParagraphReference) {
    const paragraph = activeCertificate?.paragraphs.find((item) => item.id === paragraphId) ?? null
    focusParagraph(paragraphId)
    setIsIdeAssistantVisible(false)
    setSelectedKnowledgeReferenceId(getReferenceIdentity(reference))
    setVerifyInsightTab(reference.type)
    syncActiveSentence(paragraph, reference, { syncInsight: false })
    revealInsightPanel()
  }

  function handleOpenEvidenceLinking() {
    openCaseCenter('review')
    setPreviewPanelMode('preview')
    revealInsightPanel()
  }

  function renderEvidencePreview(view: 'full' | 'source' | 'details' = 'full'): ReactNode {
    if (!previewEvidence) {
      if (!activeParagraph) {
        return <div className="empty-box">请先在左侧选择证据文件，或在中间文书中点选需要核验的段落。</div>
      }

      const sentenceFocus = activeParagraph.linkageFocus?.find(item => item.sentenceIndex === activeSentenceSelection.index)
      return <div className="empty-box">{sentenceFocus?.priority === 'skip'
        ? '本句无需材料核验。'
        : '所选句子尚无对应材料，可从证据目录查看原件。'}</div>
    }

    const canOpenOriginal = Boolean(previewSource)
    const highlightText = previewLink?.quote || activeSentenceText || activeParagraph?.text || ''
    const sourceType = previewEvidence.type
    const summaryLines = previewEvidence.ocrText.split('\n').filter((line) => line.trim())
    const evidenceFormatLabel = getEvidenceFormatLabel(previewEvidence)
    const previewLocator = previewLink?.locator || previewEvidence.anchorHint || '未绑定具体段落'
    const isSummarizingCurrentEvidence =
      summarizingEvidenceId === previewEvidence.id || previewEvidence.summaryStatus === 'processing'
    const previewInsight = [...(appState?.evidenceInsights ?? [])]
      .filter((item) => item.evidenceId === previewEvidence.id)
      .sort((a, b) => b.version - a.version)[0]
    const attentionTerms = getAttentionTerms(
      !isSummarizingCurrentEvidence && previewEvidence.summaryStatus === 'ready' ? previewInsight : undefined,
    )
    const renderPreviewText = (text: string) => (
      <AttentionText text={text} terms={[...attentionTerms, highlightText].filter(Boolean)} />
    )

    let previewNode: ReactNode = (
      <div className="preview-empty">
        当前原件暂未生成可视化预览，请打开原件或查看下方摘要。
      </div>
    )

    if (sourceType === 'image' && previewSource) {
      previewNode = (
        <button className="preview-image-button" type="button" onClick={handleOpenImageViewer}>
          <img
            className="preview-image"
            src={previewSource}
            alt={previewEvidence.name}
          />
        </button>
      )
    } else if (sourceType === 'word') {
      previewNode = <StabilityBoundary module key={previewEvidence.id}>
        <WordPreviewSurface evidence={previewEvidence} sourceUrl={previewSource} />
      </StabilityBoundary>
    } else if (sourceType === 'pdf' && previewSource) {
      previewNode = <StabilityBoundary module key={previewSource}>
        <Suspense fallback={<p role="status">正在读取原件...</p>}>
          <PdfPreview sourceUrl={previewSource} name={previewEvidence.name} />
        </Suspense>
      </StabilityBoundary>
    } else if (sourceType === 'ppt' && previewSource) {
      previewNode = (
        <iframe
          className="preview-frame"
          src={previewSource}
          title={previewEvidence.name}
        />
      )
    } else if (previewSource) {
      previewNode = <TextOriginalPreview key={`${previewEvidence.id}:${previewSource}`} sourceUrl={previewSource} fileName={previewEvidence.fileName} />
    }

    const infoRows = [
      ['文件名称', previewEvidence.fileName],
      ['材料类型', evidenceFormatLabel],
      ['文件格式', getEvidenceExtension(previewEvidence.fileName)],
      ['源目录', previewEvidence.relativePath ?? previewEvidence.fileName],
      ['定位信息', previewLocator],
      ['导入时间', formatDateTime(previewEvidence.uploadedAt)],
    ]

    const previewBody =
      previewPanelMode === 'preview' ? (
        <div className="preview-stage">{previewNode}</div>
      ) : previewPanelMode === 'text' ? (
        <div className="document-source preview-stage">
          <div className="document-source-header">
            <span>{previewEvidence.fileName}</span>
            <span>抽取文本</span>
          </div>
          <div className="document-source-paper">
            {summaryLines.map((line, index) => (
              <p key={`${previewEvidence.id}-text-${index}`}>
                {renderPreviewText(line)}
              </p>
            ))}
          </div>
        </div>
      ) : (
        <div className="preview-info-grid preview-stage">
          {infoRows.map(([label, value]) => (
            <div className="preview-info-item" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      )

    if (view === 'source') {
      return (
        <div className="ide-source-browser">
          <div className="preview-toolbar" role="group" aria-label="原件显示方式">
            {(['preview', 'text', 'meta'] as const).map((mode) => (
              <button key={mode} type="button" className={previewPanelMode === mode ? 'active' : ''}
                onClick={() => setPreviewPanelMode(mode)}>
                {{ preview: '原件预览', text: '抽取文本', meta: '文件信息' }[mode]}
              </button>
            ))}
            {canOpenOriginal ? <a className="ghost-button viewer-link" href={previewSource}
              target="_blank" rel="noreferrer">打开原件</a> : null}
          </div>
          {previewBody}
        </div>
      )
    }

    return (
      <div className="preview-card">
        <div className="preview-meta">
          <div>
            <strong>
              {previewEvidence.number} {previewEvidence.name}
            </strong>
          </div>
          <div className="preview-meta-actions">
            <span className="preview-format-badge">{evidenceFormatLabel}</span>
            <button
              className="ghost-button"
              type="button"
              onClick={() => void handleSummarizeEvidence(previewEvidence.id, { force: Boolean(previewEvidence.summaryText?.trim()) })}
              disabled={isSummarizingCurrentEvidence}
            >
              {isSummarizingCurrentEvidence ? 'AI 理解中...' : previewEvidence.summaryText ? '重新理解原材料' : 'AI 理解原材料'}
            </button>
            <span className="point-cost-hint">
              {previewEvidence.summaryText?.trim()
                ? '已理解 · 重新理解将扣分'
                : `预计扣分 ${getEstimatedActionPoints('evidence_summary')} 积分`}
            </span>
            {canOpenOriginal ? (
              <a
                className="ghost-button viewer-link"
                href={previewSource}
                download={previewEvidence.fileName}
                target="_blank"
                rel="noreferrer"
              >
                打开原件
              </a>
            ) : null}
          </div>
        </div>

        {!isManualEvidencePreview && previewLink?.reason ? (
          <div className={`linkage-reason ${previewLink.relation ?? 'support'}`}>
            <strong>{previewLink.relation === 'contradict' ? '存在矛盾'
              : previewLink.relation === 'context' ? '待核验线索' : '支撑事实'}</strong>
            <span>{previewLink.reason}</span>
          </div>
        ) : null}

        {!isManualEvidencePreview && activeSentenceEvidenceLinks.length > 1 ? (
          <div className="reference-switcher">
            {activeSentenceEvidenceLinks.map((link) => {
              const index = activeParagraphLinks.indexOf(link)
              const evidence = caseEvidences.find((item) => item.id === link.evidenceId)

              return (
                <button
                  key={getLinkKey(link, index)}
                  className={`reference-card-tab ${index === activeReferenceIndex ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setActiveReferenceIndex(index)
                    syncActiveSentence(activeParagraph, link, { syncInsight: false })
                  }}
                >
                  <strong>{evidence ? `${evidence.number} ${evidence.name}` : `引用 ${index + 1}`}</strong>
                  <span>{link.locator}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        {view !== 'details' ? <div className="preview-section">
          <div className="preview-section-head">
            <strong>源文件预览</strong>
            <div className="preview-toolbar">
              {[
                ['preview', '原件预览'],
                ['text', '抽取文本'],
                ['meta', '文件信息'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={previewPanelMode === key ? 'active' : ''}
                  type="button"
                  onClick={() => setPreviewPanelMode(key as PreviewPanelMode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {previewBody}
        </div> : null}
        <EvidenceAttention
          key={previewEvidence.id}
          evidence={previewEvidence}
          insight={previewInsight}
          processing={isSummarizingCurrentEvidence}
        />
      </div>
    )
  }

  function renderImageViewer(): ReactNode {
    if (!imageViewerState) {
      return null
    }

    return (
      <div
        className="image-viewer-backdrop"
        onClick={() => setImageViewerState(null)}
        role="presentation"
      >
        <div
          className="image-viewer-dialog"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={imageViewerState.title}
        >
          <div className="image-viewer-head">
            <div>
              <strong>{imageViewerState.title}</strong>
              <span>{Math.round(imageViewerState.scale * 100)}%</span>
            </div>
            <div className="image-viewer-actions">
              <button type="button" onClick={() => updateImageViewerScale(imageViewerState.scale - 0.25)}>
                缩小
              </button>
              <button type="button" onClick={() => updateImageViewerScale(1)}>
                还原
              </button>
              <button type="button" onClick={() => updateImageViewerScale(imageViewerState.scale + 0.25)}>
                放大
              </button>
              <button type="button" onClick={() => setImageViewerState(null)}>
                关闭
              </button>
            </div>
          </div>
          <div className="image-viewer-stage">
            <img
              className="image-viewer-image"
              src={imageViewerState.src}
              alt={imageViewerState.title}
              style={{ transform: `scale(${imageViewerState.scale})` }}
            />
          </div>
        </div>
      </div>
    )
  }

  function renderCaseDialog(): ReactNode {
    if (!caseDialogState) {
      return null
    }

    const isEntryCreateDialog = caseDialogState.mode === 'create'
      && entryOnboardingStep === 'create-case'
      && (!appState || appState.cases.length === 0)

    return (
      <div className="case-dialog-backdrop" onClick={handleCloseCaseDialog}>
        <div
          className="case-dialog"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={caseDialogState.title}
        >
          <div className="case-dialog-head">
            <div>
              <span className="eyebrow">案件管理</span>
              <h2>{caseDialogState.title}</h2>
              {isEntryCreateDialog ? (
                <p>先建立一个案件，后续导入的本地材料、生成的质证书和核验进度都会归到这里。</p>
              ) : null}
            </div>
            <button className="ghost-button" type="button" onClick={handleCloseCaseDialog} disabled={isSubmitting}>
              关闭
            </button>
          </div>

          <label className="field-block">
            案件名称
            <input
              value={caseDialogState.value}
              onChange={(event) => setCaseDialogState((current) => current ? { ...current, value: event.target.value } : null)}
              placeholder="例如：王某买卖合同纠纷"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void handleSubmitCaseDialog()
                }
              }}
            />
          </label>

          <div className="case-dialog-actions">
            <button className="ghost-button" type="button" onClick={handleCloseCaseDialog} disabled={isSubmitting}>
              取消
            </button>
            <button className="primary-button" type="button" onClick={() => void handleSubmitCaseDialog()} disabled={isSubmitting}>
              {isSubmitting ? '提交中...' : caseDialogState.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    )
  }

  function renderRechargeDialog(): ReactNode {
    if (!rechargeDialogState) {
      return null
    }

    const selectedPackage = rechargeDialogState.packages.find((item) => item.id === rechargeDialogState.selectedPackageId) ?? null
    const selectedProvider = rechargeDialogState.providers.find((item) => item.id === rechargeDialogState.selectedChannel) ?? null
    const activeOrder = rechargeDialogState.activeOrder
    const recentOrders = (appState?.paymentOrders ?? []).slice(0, 8)
    const paidOrders = (appState?.paymentOrders ?? []).filter((item) => item.status === 'paid')
    const pendingOrders = (appState?.paymentOrders ?? []).filter((item) => item.status === 'pending')
    const paidAmountFen = paidOrders.reduce((total, item) => total + item.amountFen, 0)
    const paidPoints = paidOrders.reduce((total, item) => total + item.points, 0)

    return (
      <div className="knowledge-library-backdrop" onClick={handleCloseRechargeDialog}>
        <div
          className="recharge-dialog"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="积分充值"
        >
          <div className="recharge-dialog-head">
            <div>
              <span className="eyebrow">订单支付中心</span>
              <h2>积分充值</h2>
              <p>按商用支付链路创建订单，支持支付宝与微信扫码支付，支付成功后自动入账积分。</p>
            </div>
            <button className="ghost-button" type="button" onClick={handleCloseRechargeDialog} disabled={isSubmitting}>
              关闭
            </button>
          </div>

          <div className="recharge-dialog-body">
            <section className="recharge-config-panel">
              <div className="recharge-order-summary recharge-order-summary-admin">
                <div>
                  <span>历史订单</span>
                  <strong>{appState?.paymentOrders.length ?? 0} 笔</strong>
                </div>
                <div>
                  <span>待支付</span>
                  <strong>{pendingOrders.length} 笔</strong>
                </div>
                <div>
                  <span>累计充值</span>
                  <strong>{formatFenToCurrency(paidAmountFen)}</strong>
                </div>
                <div>
                  <span>累计积分</span>
                  <strong>{paidPoints} 积分</strong>
                </div>
              </div>

              <div className="recharge-panel-section">
                <div className="preview-section-head">
                  <strong>选择套餐</strong>
                  <span>当前积分：{appState?.user.points ?? 0}</span>
                </div>
                <div className="recharge-package-grid">
                  {rechargeDialogState.packages.map((item) => (
                    <button
                      key={item.id}
                      className={`recharge-package-card ${rechargeDialogState.selectedPackageId === item.id ? 'active' : ''}`}
                      type="button"
                      onClick={() => setRechargeDialogState((current) => current ? { ...current, selectedPackageId: item.id } : current)}
                    >
                      <strong>{item.title}</strong>
                      <span>{item.description}</span>
                      <div className="recharge-package-meta">
                        <em>{item.points} 积分</em>
                        <strong>{formatFenToCurrency(item.amountFen)}</strong>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="recharge-panel-section">
                <div className="preview-section-head">
                  <strong>支付通道</strong>
                  <span>{selectedProvider?.enabled ? '已就绪' : '待配置'}</span>
                </div>
                <div className="recharge-channel-row">
                  {rechargeDialogState.providers.map((provider) => (
                    <button
                      key={provider.id}
                      className={`recharge-channel-card ${rechargeDialogState.selectedChannel === provider.id ? 'active' : ''}`}
                      type="button"
                      onClick={() => {
                        if (!provider.enabled) {
                          return
                        }
                        setRechargeDialogState((current) => current ? { ...current, selectedChannel: provider.id } : current)
                      }}
                      disabled={!provider.enabled}
                    >
                      <strong>{provider.label}</strong>
                      <span>{provider.enabled ? '扫码支付' : provider.reason || '暂未启用'}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="recharge-order-summary">
                <div>
                  <span>支付金额</span>
                  <strong>{selectedPackage ? formatFenToCurrency(selectedPackage.amountFen) : '--'}</strong>
                </div>
                <div>
                  <span>到账积分</span>
                  <strong>{selectedPackage?.points ?? '--'} 积分</strong>
                </div>
                <div>
                  <span>支付方式</span>
                  <strong>{getPaymentProviderLabel(rechargeDialogState.selectedChannel)}</strong>
                </div>
              </div>

              <div className="recharge-actions">
                <button className="ghost-button" type="button" onClick={handleCloseRechargeDialog} disabled={isSubmitting}>
                  稍后再说
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void handleCreateRechargeOrder()}
                  disabled={isSubmitting || !selectedProvider?.enabled || !selectedPackage}
                >
                  {isSubmitting ? '正在创建订单...' : '生成支付二维码'}
                </button>
              </div>

              <div className="recharge-panel-section">
                <div className="preview-section-head">
                  <strong>订单管理</strong>
                  <span>最近 8 笔</span>
                </div>
                {recentOrders.length ? (
                  <div className="recharge-order-list">
                    {recentOrders.map((order) => (
                      <button
                        key={order.id}
                        className={`recharge-order-row ${activeOrder?.id === order.id ? 'active' : ''}`}
                        type="button"
                        onClick={() => void handleSelectRechargeOrder(order)}
                      >
                        <div className="recharge-order-row-main">
                          <strong>{getPaymentProviderLabel(order.channel)}</strong>
                          <span>{formatFenToCurrency(order.amountFen)} / {order.points} 积分</span>
                        </div>
                        <div className="recharge-order-row-meta">
                          <span className={`status-chip ${getRechargeOrderStatusTone(order.status)}`}>
                            {getRechargeOrderStatusLabel(order.status)}
                          </span>
                          <span>{formatDateTime(order.createdAt)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="summary-empty">当前还没有生成过支付订单，创建后会在这里统一管理。</div>
                )}
              </div>
            </section>

            <section className="recharge-qr-panel">
              {activeOrder ? (
                <>
                  <div className="recharge-qr-head">
                    <div>
                      <strong>{getPaymentProviderLabel(activeOrder.channel)}扫码支付</strong>
                      <span>{getRechargeOrderStatusLabel(activeOrder.status)}</span>
                    </div>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => void refreshRechargeOrder(activeOrder.id)}
                      disabled={isSubmitting}
                    >
                      刷新状态
                    </button>
                  </div>
                  <div className="recharge-qr-stage">
                    {rechargeDialogState.qrCodeDataUrl ? (
                      <img src={rechargeDialogState.qrCodeDataUrl} alt="支付二维码" className="recharge-qr-image" />
                    ) : (
                      <div className="summary-empty">二维码生成中...</div>
                    )}
                  </div>
                  <div className="recharge-order-info">
                    <span>订单号：{activeOrder.outTradeNo}</span>
                    <span>金额：{formatFenToCurrency(activeOrder.amountFen)}</span>
                    <span>积分：{activeOrder.points} 积分</span>
                    <span>创建时间：{formatDateTime(activeOrder.createdAt)}</span>
                    <span>有效期至：{formatDateTime(activeOrder.expiresAt)}</span>
                    {activeOrder.providerMessage ? <span>通道状态：{activeOrder.providerMessage}</span> : null}
                  </div>
                  {activeOrder.status === 'paid' ? (
                    <div className="recharge-success-banner">
                      支付已完成，积分已经自动入账。
                    </div>
                  ) : (
                    <div className="summary-empty">
                      请使用手机扫码完成支付，桌面端会自动轮询支付状态并刷新积分余额。
                    </div>
                  )}
                </>
              ) : (
                <div className="summary-empty">
                  请选择套餐与支付通道，生成订单后会在这里显示二维码和订单状态。
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    )
  }

  function renderFeedbackDialog(): ReactNode {
    if (!feedbackDialogState) {
      return null
    }

    const pageContext = activeTab === 'workspace' ? `workspace/${caseCenterTab}` : activeTab

    return (
      <div className="knowledge-library-backdrop" onClick={handleCloseFeedbackDialog}>
        <div
          className="feedback-dialog"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="用户反馈"
        >
          <div className="feedback-dialog-head">
            <div>
              <span className="eyebrow">用户反馈</span>
              <h2>提交产品反馈</h2>
              <p>直接把问题、建议或体验感受提交到云端后台，超级管理员可统一查看趋势、分类与明细。</p>
            </div>
            <button className="ghost-button" type="button" onClick={handleCloseFeedbackDialog} disabled={isSubmitting}>
              关闭
            </button>
          </div>

          <div className="feedback-dialog-body">
            <section className="feedback-dialog-main">
              <div className="feedback-dialog-field-grid">
                <label className="field-block">
                  反馈类型
                  <select
                    className="streamlined-case-select"
                    value={feedbackDialogState.feedbackType}
                    onChange={(event) => setFeedbackDialogState((current) => current ? {
                      ...current,
                      feedbackType: event.target.value as FeedbackType,
                    } : null)}
                  >
                    <option value="bug">问题反馈</option>
                    <option value="suggestion">功能建议</option>
                    <option value="experience">体验评价</option>
                    <option value="other">其他</option>
                  </select>
                </label>

                <label className="field-block">
                  联系方式
                  <input
                    value={feedbackDialogState.contact}
                    onChange={(event) => setFeedbackDialogState((current) => current ? {
                      ...current,
                      contact: event.target.value,
                    } : null)}
                    placeholder="邮箱、手机号或微信，方便回访时联系"
                  />
                </label>
              </div>

              <label className="field-block">
                反馈标题
                <input
                  value={feedbackDialogState.title}
                  onChange={(event) => setFeedbackDialogState((current) => current ? {
                    ...current,
                    title: event.target.value,
                  } : null)}
                  placeholder="例如：证据目录切换案件后列表没有及时刷新"
                  autoFocus
                />
              </label>

              <label className="field-block">
                详细说明
                <textarea
                  value={feedbackDialogState.content}
                  onChange={(event) => setFeedbackDialogState((current) => current ? {
                    ...current,
                    content: event.target.value,
                  } : null)}
                  rows={8}
                  placeholder="请尽量说明出现位置、复现步骤、期望结果，或你希望新增的能力。"
                />
              </label>
            </section>

            <aside className="feedback-dialog-side">
              <div className="feedback-context-card">
                <strong>本次附带上下文</strong>
                <div className="feedback-context-grid">
                  <div>
                    <span>当前账号</span>
                    <strong>{sidebarPrimaryIdentity}</strong>
                  </div>
                  <div>
                    <span>桌面端版本</span>
                    <strong>v{__APP_VERSION__}</strong>
                  </div>
                  <div>
                    <span>当前页面</span>
                    <strong>{pageContext}</strong>
                  </div>
                  <div>
                    <span>当前案件</span>
                    <strong>{selectedCase?.name ?? '未选择案件'}</strong>
                  </div>
                </div>
              </div>

              <div className="feedback-context-card feedback-context-note">
                <strong>建议这样写更快定位</strong>
                <p>问题反馈可写“操作步骤 + 实际结果 + 期望结果”；功能建议可写“当前痛点 + 希望新增什么”。</p>
                <p>已提交内容会进入云端超级管理员后台，支持按类型、状态、版本和关键词做统计分析。</p>
              </div>
            </aside>
          </div>

          <div className="case-dialog-actions">
            <button className="ghost-button" type="button" onClick={handleCloseFeedbackDialog} disabled={isSubmitting}>
              取消
            </button>
            <button className="primary-button" type="button" onClick={() => void handleSubmitFeedback()} disabled={isSubmitting}>
              {isSubmitting ? '提交中...' : '提交反馈'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  function renderKnowledgeLibraryDialog(): ReactNode {
    if (!isKnowledgeLibraryDialogOpen) {
      return null
    }

    return (
      <div className="knowledge-library-backdrop ide-knowledge-backdrop" onClick={handleCloseKnowledgeLibraryDialog}>
        <div
          className="knowledge-library-dialog"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="法律知识库模块"
          tabIndex={-1}
        >
          <div className="knowledge-library-head">
            <div>
              <span className="eyebrow">法律知识库模块</span>
              <h2>知识库配置与文件上传</h2>
              <p>可直接上传 Word、PDF、RTF、TXT、Markdown、WPS 等常见文件，并在右侧查看文件详情与预览。</p>
            </div>
            <button className="ghost-button" type="button" onClick={handleCloseKnowledgeLibraryDialog}>
              关闭
            </button>
          </div>

          <section className="tab-row section-nav knowledge-library-nav">
            <button className="active" type="button">
              知识文件
            </button>
          </section>

          <div
            ref={knowledgeLibraryBodyRef}
            className={`knowledge-library-body ${isResizingKnowledgeFilesSidebar ? 'is-resizing' : ''}`}
          >
            {settingsTab === 'files' ? (
              <aside
                className="knowledge-library-files-sidebar"
                aria-label="上传文件列表"
                style={{ width: `${knowledgeFilesSidebarWidth}px` }}
              >
                <div className="knowledge-library-files-sidebar-head">
                  <strong>上传文件列表</strong>
                  <label className="upload-button compact-upload-button">
                    {knowledgeUploadProgress && knowledgeUploadProgress.stage !== 'failed' && knowledgeUploadProgress.stage !== 'complete'
                      ? '处理中...'
                      : '上传文件'}
                    <input
                      id={knowledgeFileUploadInputId}
                      className="visually-hidden-file-input"
                      type="file"
                      accept=".docx,.doc,.rtf,.txt,.md,.markdown,.pdf,.wps"
                      multiple
                      onChange={(event) => void handleKnowledgeFileUpload(event)}
                    />
                  </label>
                </div>
                {renderKnowledgeUploadProgressCard(true)}

                <div className="knowledge-library-file-table">
                  <div className="knowledge-library-file-table-head">
                    <span>文件名</span>
                  </div>

                  <div className="knowledge-library-file-table-body">
                    {filteredSettingsKnowledgeFiles.length ? filteredSettingsKnowledgeFiles.map((entry) => (
                      <button
                        key={entry.id}
                        className={`knowledge-library-file-row ${selectedSettingsKnowledgeFile?.id === entry.id ? 'active' : ''}`}
                        type="button"
                        onClick={() => setSettingsSelectedKnowledgeFileId(entry.id)}
                      >
                        <span className="knowledge-library-file-name" title={entry.title}>{entry.title}</span>
                      </button>
                    )) : (
                      <div className="empty-box">还没有上传知识文件。</div>
                    )}
                  </div>
                </div>
              </aside>
            ) : (
              <aside
                className="sidebar knowledge-library-sidebar-cleared"
                aria-label="知识库设置侧栏"
              />
            )}
            {settingsTab === 'files' ? (
              <div
                className="knowledge-library-files-resizer"
                onPointerDown={handleStartKnowledgeFilesSidebarResize}
                onDoubleClick={() => setKnowledgeFilesSidebarWidth(DEFAULT_KNOWLEDGE_FILES_SIDEBAR_WIDTH)}
                role="separator"
                aria-orientation="vertical"
                aria-label="调整上传文件列表宽度"
                tabIndex={0}
              />
            ) : null}
            <div className="knowledge-library-main">
              {renderSettingsCenter()}
            </div>
          </div>
        </div>
      </div>
    )
  }

  function renderAgentDock(inline = false): ReactNode {
    const isRewriteMode = Boolean(activeCertificate)
    const availableEvidenceCount = (selectedEvidenceIds.length ? selectedEvidenceIds : activeCertificateEvidenceIds).length
    const canSubmit = Boolean(selectedCase && availableEvidenceCount && !isSubmitting)
    const estimatedDraftPoints = getEstimatedActionPoints('pleading_full')

    return (
      <div
        ref={agentDockRef}
        className={`agent-dock ${inline ? 'ide-agent-panel' : ''} ${inline || isAgentWindowOpen ? 'is-open' : 'is-collapsed'} ${isDraggingAgentDock ? 'is-dragging' : ''}`}
        style={inline ? undefined : { left: `${agentDockPosition.x}px`, top: `${agentDockPosition.y}px` }}
      >
        {inline || isAgentWindowOpen ? (
          <div className="agent-dock-card" role={inline ? 'region' : 'dialog'} aria-label={inline ? '案件与文书助手' : undefined}
            aria-labelledby={inline ? undefined : 'agent-dock-title'}>
            {inline ? null : <div className="agent-dock-head">
              <div
                className="agent-dock-handle"
                onPointerDown={handleStartAgentDockDrag}
                role="button"
                tabIndex={0}
                title="按住拖动位置"
              >
                <span className="agent-dock-brand-mark" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                  </svg>
                </span>
                <div className="agent-dock-head-main">
                  <strong id="agent-dock-title">{agentMode === 'case' ? '案件助手' : isRewriteMode ? '修改文书' : '起草文书'}</strong>
                </div>
                <span className="agent-dock-handle-grip" aria-hidden="true" />
              </div>
              <button className="agent-dock-collapse" type="button" onClick={handleCollapseAgentWindow}>
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                收起
              </button>
            </div>}

            <div className="agent-dock-body">
              <div className="agent-dock-mode-switch" role="group" aria-label="助手模式">
                <button aria-pressed={agentMode === 'case'} type="button" onClick={() => setAgentMode('case')}>案件沟通</button>
                <button aria-pressed={agentMode === 'document'} type="button" onClick={() => setAgentMode('document')}>文书起草</button>
              </div>
              {agentMode === 'case' ? selectedCase && appState ? <CaseAgentPanel
                key={`${loginAccount}:${selectedCase.id}`} folder={selectedCase} workspace={appState}
                onWorkspace={workspace => applyWorkspace(workspace, { selectedCaseId: selectedCase.id }, { preserveManualPreview: true })}
                onEvidence={id => {
                  const evidence = appState.evidences.find(e => e.id === id)
                  if (evidence) handlePreviewEvidenceItem(evidence)
                }}
              /> : <p>请先选择案件。</p> : null}
              {agentMode === 'document' && agentMessages.length ? (
                <div className="agent-message-list">
                  {agentMessages.map((message) => (
                    <article key={message.id} className={`agent-message ${message.role}`}>
                      <strong>{message.role === 'assistant' ? '文书助手' : '你'}</strong>
                      <p>{message.content}</p>
                    </article>
                  ))}
                </div>
              ) : null}

              {agentMode === 'document' ? <div className="agent-input-shell agent-dock-input-shell">
                <AgentPromptInput ref={agentPromptInputRef} draftRef={agentPromptRef} disabled={isSubmitting}
                  placeholder={isRewriteMode ? '输入需要调整的内容或改写要求…' : '描述文书类型与起草要求…'} />
                <div className="agent-dock-submit-area">
                  <div className="agent-dock-composer-meta">
                    <span>{!selectedCase ? '请选择案件' : availableEvidenceCount ? `已选 ${availableEvidenceCount} 份证据` : '请选择证据'}</span>
                    <span className="agent-dock-cost">预计 <b>{estimatedDraftPoints}</b> 积分</span>
                  </div>
                  <div className="agent-composer-actions">
                    <button
                      className="agent-dock-clear"
                      type="button"
                      onClick={() => setAgentPrompt('')}
                      disabled={isSubmitting}
                    >
                      清空
                    </button>
                    <button
                      className={`agent-dock-submit ${isSubmitting ? 'is-busy' : ''}`}
                      type="button"
                      onClick={() => void (isRewriteMode ? handleRewriteCertificate() : handleGenerateCertificate())}
                      disabled={!canSubmit}
                    >
                      {isSubmitting ? (isRewriteMode ? '正在改写...' : '正在生成...') : (isRewriteMode ? '继续改写' : '开始生成')}
                      {!isSubmitting ? <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
                    </button>
                  </div>
                </div>
              </div> : null}
            </div>
          </div>
        ) : (
          <button
            className="agent-dock-trigger"
            type="button"
            onClick={handleExpandAgentDock}
            onPointerDown={handleStartAgentDockDrag}
            aria-label="打开案件助手"
            title="拖动可移动，点击可展开"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span className="agent-dock-trigger-label">助手</span>
          </button>
        )}
      </div>
    )
  }

  function renderStatuteReferencePanel() {
    const statutePreviewText = (() => {
      if (!selectedStatuteReferenceBinding) {
        return ''
      }

      const currentContent = selectedStatuteReferenceBinding.article.content
      if (!isPlaceholderStatuteContent(currentContent)) {
        return currentContent
      }

      return selectedStatuteReferenceKnowledgePreview?.articlePreview ?? currentContent
    })()

    return (
      <div className="knowledge-stack">
        <LegalReview editor={activeParagraphId ? paragraphEditorsRef.current[activeParagraphId] ?? null : null}
          active account={loginAccount} automatic={false} />
        {selectedStatuteReference && selectedStatuteReferenceBinding ? (
          <div className="insight-card">
            <div className="preview-section-head">
              <strong>当前法条预览</strong>
              <div className="preview-section-actions">
                <span>{selectedStatuteReferenceBinding.article.articleNumber}</span>
                <button
                  className="preview-settings-entry"
                  type="button"
                  onClick={() => handleOpenStatuteSettings(
                    selectedStatuteReferenceBinding.document.id,
                    selectedStatuteReferenceBinding.article.id,
                  )}
                >
                  知识库设置
                </button>
              </div>
            </div>
            {selectedStatuteReference.reason ? (
              <div className="linkage-reason"><strong>关联争议</strong><span>{selectedStatuteReference.reason}</span></div>
            ) : null}
            <div className="knowledge-detail-block">
              <strong>{selectedStatuteReferenceBinding.document.title} {selectedStatuteReferenceBinding.article.articleNumber}</strong>
              <p>{statutePreviewText}</p>
              <div className="inline-actions">
                <span>
                  {selectedStatuteReferenceKnowledgePreview
                    ? `知识库原文：${selectedStatuteReferenceKnowledgePreview.file.fileName}`
                    : (selectedStatuteReferenceBinding.document.sourceAuthority
                      ?? selectedStatuteReferenceBinding.document.issuer)}
                </span>
                <div>
                  {selectedStatuteReferenceBinding.document.sourceTextUrl
                    || selectedStatuteReferenceBinding.document.sourcePdfUrl
                    || selectedStatuteReferenceBinding.document.sourceUrl ? (
                    <a
                      className="text-link viewer-link"
                      href={
                        selectedStatuteReferenceBinding.document.sourceTextUrl
                        ?? selectedStatuteReferenceBinding.document.sourcePdfUrl
                        ?? selectedStatuteReferenceBinding.document.sourceUrl
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      官方原文
                    </a>
                  ) : null}
                  <span>{selectedStatuteReferenceBinding.article.articleNumber}</span>
                </div>
              </div>
            </div>
            {selectedStatuteReferenceInterpretations.length ? (
              <div className="knowledge-detail-block">
                <strong>相关司法解释</strong>
                <div className="knowledge-reference-list">
                  {selectedStatuteReferenceInterpretations.map(({ document, article }) => (
                    <article className="knowledge-reference-card" key={`${document.id}-${article.id}`}>
                      <div>
                        <strong>{document.title} {article.articleNumber}</strong>
                        <span>{document.docType} · {document.version}</span>
                      </div>
                      <p>{article.content}</p>
                      <div className="inline-actions">
                        <span>{document.issuer}</span>
                        <div>
                          <span
                            className="text-link"
                            onClick={() => {
                              setSelectedStatuteId(document.id)
                              setSelectedArticleId(article.id)
                              setActiveTab('knowledge')
                              setKnowledgeTab('statutes')
                            }}
                          >
                            查看全文
                          </span>
                          <span
                            className="text-link"
                            onClick={() => {
                              void handleBindStatute(article, document)
                            }}
                          >
                            绑定到段落
                          </span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="insight-card">
          <div className="preview-section-head">
            <strong>推荐法条</strong>
            <span>围绕当前案件与段落自动筛选</span>
          </div>
          <div className="knowledge-reference-list">
            {recommendedKnowledgeStatutes.map((document) =>
              document.articles.slice(0, 2).map((article) => (
                <article className="knowledge-reference-card" key={article.id}>
                  <div>
                    <strong>{document.title} {article.articleNumber}</strong>
                    <span>{document.docType} · {document.version}</span>
                  </div>
                  <p>{article.content}</p>
                  <div className="inline-actions">
                    <span>{document.keywords.slice(0, 3).join(' / ')}</span>
                    <div>
                      <span
                        className="text-link"
                        onClick={() => {
                          setSelectedStatuteId(document.id)
                          setSelectedArticleId(article.id)
                          setActiveTab('knowledge')
                          setKnowledgeTab('statutes')
                        }}
                      >
                        查看全文
                      </span>
                      <span
                        className="text-link"
                        onClick={() => {
                          void handleBindStatute(article, document)
                        }}
                      >
                        绑定到段落
                      </span>
                    </div>
                  </div>
                </article>
              )),
            )}
          </div>
        </div>
      </div>
    )
  }

  function renderCaseReferencePanel() {
    return (
      <div className="knowledge-stack">
        <LegalReview editor={activeParagraphId ? paragraphEditorsRef.current[activeParagraphId] ?? null : null}
          active account={loginAccount} automatic={false} />
        <CaseSearchPanel onOpen={entry => { void handleOpenKnowledgeCaseDetail(entry) }} />
        {selectedCaseReference && selectedCaseReferenceBinding ? (
          <div className="insight-card">
            <div className="preview-section-head">
              <strong>当前案例预览</strong>
              <span>{getKnowledgeCaseSourceLabel(selectedCaseReferenceBinding.entry.sourceType)}</span>
            </div>
            {selectedCaseReference.reason ? (
              <div className="linkage-reason"><strong>关联争议</strong><span>{selectedCaseReference.reason}</span></div>
            ) : null}
            <div className="knowledge-detail-block">
              <strong>{selectedCaseReferenceBinding.entry.title}</strong>
              <p>{selectedCaseReferenceBinding.excerpt.content}</p>
              <div className="inline-actions">
                <span>{selectedCaseReferenceBinding.entry.courtName} · {selectedCaseReferenceBinding.entry.caseNumber}</span>
                <span>{selectedCaseReferenceBinding.entry.cause}</span>
              </div>
            </div>
          </div>
        ) : null}

        <div className="insight-card">
          <div className="preview-section-head">
            <strong>推荐案例</strong>
            <span>联查元典、威科、北大法宝</span>
          </div>
          <div className="knowledge-reference-list">
            {recommendedKnowledgeCases.map((entry) =>
              entry.excerpts.slice(0, 2).map((excerpt) => (
                <article className="knowledge-reference-card" key={excerpt.id}>
                  <div>
                    <strong>{entry.title}</strong>
                    <span>{entry.courtName} · {entry.caseNumber} · {getKnowledgeCaseSourceLabel(entry.sourceType)}</span>
                  </div>
                  <p>{excerpt.content}</p>
                  <div className="inline-actions">
                    <span>{excerpt.locator}</span>
                    <div>
                      <span
                        className="text-link"
                        onClick={() => {
                          void handleOpenKnowledgeCaseDetail(entry)
                        }}
                      >
                        查看详情
                      </span>
                      <span
                        className="text-link"
                        onClick={() => {
                          void handleBindCaseExcerpt(excerpt, entry)
                        }}
                      >
                        绑定到段落
                      </span>
                    </div>
                  </div>
                </article>
              )),
            )}
          </div>
        </div>
      </div>
    )
  }

  function renderMemoryPanel() {
    const caseMemory = selectedCaseContextMemory
    const disputeFocuses = caseMemory?.disputeFocuses ?? []
    const claimsAndDefenses = caseMemory?.claimsAndDefenses ?? []
    const timelineItems = caseMemory?.timeline ?? []
    const keyPersons = caseMemory?.keyPersons ?? []
    const keyAmounts = caseMemory?.keyAmounts ?? []
    const lawyerFocuses = caseMemory?.lawyerFocuses ?? []
    const evidenceWeaknesses = caseMemory?.evidenceWeaknesses ?? []
    const proceduralRisks = caseMemory?.proceduralRisks ?? []
    const supportMatrix = caseMemory?.supportMatrix ?? []
    const openQuestions = caseMemory?.openQuestions ?? []
    const contradictionItems = caseMemory?.contradictions ?? []

    return (
      <div className="knowledge-stack memory-stack">
        <div className="insight-card memory-overview-card">
          <div className="preview-section-head">
            <strong>案件记忆总览</strong>
            <div className="memory-head-actions">
              <span>{caseMemory ? `更新于 ${formatDateTime(caseMemory.updatedAt)}` : '待建立'}</span>
              <button
                className="ghost-button"
                type="button"
                disabled={!selectedCase || isSubmitting}
                onClick={() => void handleRebuildCaseMemory()}
              >
                重新梳理案件
              </button>
            </div>
          </div>

          <div className="memory-kpi-grid">
            <div className="memory-kpi-card">
              <span>单证据记忆</span>
              <strong>{caseEvidenceInsights.length} 份</strong>
            </div>
            <div className="memory-kpi-card">
              <span>案件上下文</span>
              <strong>{caseMemory ? '已建立' : '未建立'}</strong>
            </div>
            <div className="memory-kpi-card">
              <span>草稿写作记忆</span>
              <strong>{activeDraftMemory ? `${activeDraftMemory.paragraphPlans.length} 段` : '未沉淀'}</strong>
            </div>
          </div>

          <div className="knowledge-detail-block memory-summary-block">
            <strong>案件记忆摘要</strong>
            <p>{caseMemory?.summary || '当前案件还没有沉淀出稳定的案件级记忆，请先链接本地材料并完成解析。'}</p>
          </div>

          {disputeFocuses.length || claimsAndDefenses.length ? (
            <div className="memory-note-grid">
              {disputeFocuses.length ? (
                <div className="knowledge-detail-block">
                  <strong>争议焦点</strong>
                  <div className="memory-bullet-list">
                    {disputeFocuses.slice(0, 6).map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                </div>
              ) : null}
              {claimsAndDefenses.length ? (
                <div className="knowledge-detail-block">
                  <strong>主张与抗辩</strong>
                  <div className="memory-bullet-list">
                    {claimsAndDefenses.slice(0, 6).map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="memory-insight-grid">
          <div className="insight-card">
            <div className="preview-section-head">
              <strong>律师关注点</strong>
              <span>{lawyerFocuses.length} 项</span>
            </div>
            {lawyerFocuses.length ? (
              <div className="memory-bullet-list">
                {lawyerFocuses.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            ) : (
              <div className="empty-box">当前尚未形成明确的律师关注点。</div>
            )}
          </div>

          <div className="insight-card">
            <div className="preview-section-head">
              <strong>关键人物与金额</strong>
              <span>{keyPersons.length + keyAmounts.length} 项</span>
            </div>
            {keyPersons.length || keyAmounts.length ? (
              <div className="memory-note-grid">
                <div className="knowledge-detail-block">
                  <strong>关键人物</strong>
                  <div className="memory-bullet-list">
                    {keyPersons.length ? keyPersons.slice(0, 6).map((item) => (
                      <span key={item}>{item}</span>
                    )) : <span>当前尚未识别出稳定的关键人物。</span>}
                  </div>
                </div>
                <div className="knowledge-detail-block">
                  <strong>关键金额</strong>
                  <div className="memory-bullet-list">
                    {keyAmounts.length ? keyAmounts.slice(0, 6).map((item) => (
                      <span key={item}>{item}</span>
                    )) : <span>当前尚未识别出明确金额。</span>}
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-box">当前案件记忆尚未识别出关键人物或金额。</div>
            )}
          </div>
        </div>

        <div className="insight-card">
          <div className="preview-section-head">
            <strong>案件时间线</strong>
            <span>{timelineItems.length} 条</span>
          </div>
          {timelineItems.length ? (
            <div className="memory-timeline">
              {timelineItems.map((item, index) => (
                <div className="memory-timeline-item" key={`${index + 1}-${item}`}>
                  <span className="memory-timeline-index">{String(index + 1).padStart(2, '0')}</span>
                  <div className="memory-timeline-content">
                    <strong>{item}</strong>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-box">当前案件记忆尚未形成可复用的时间线。</div>
          )}
        </div>

        <div className="memory-insight-grid">
          <div className="insight-card">
            <div className="preview-section-head">
              <strong>证据薄弱点</strong>
              <span>{evidenceWeaknesses.length} 项</span>
            </div>
            {evidenceWeaknesses.length ? (
              <div className="memory-bullet-list">
                {evidenceWeaknesses.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            ) : (
              <div className="empty-box">当前尚未识别出明显的证据短板。</div>
            )}
          </div>

          <div className="insight-card">
            <div className="preview-section-head">
              <strong>程序风险与待补强</strong>
              <span>{proceduralRisks.length + openQuestions.length + contradictionItems.length} 项</span>
            </div>
            {proceduralRisks.length || openQuestions.length || contradictionItems.length ? (
              <div className="memory-note-grid">
                {proceduralRisks.length ? (
                  <div className="knowledge-detail-block">
                    <strong>程序风险</strong>
                    <div className="memory-bullet-list">
                      {proceduralRisks.slice(0, 5).map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {openQuestions.length ? (
                  <div className="knowledge-detail-block">
                    <strong>待补强问题</strong>
                    <div className="memory-bullet-list">
                      {openQuestions.slice(0, 5).map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {contradictionItems.length ? (
                  <div className="knowledge-detail-block">
                    <strong>已识别矛盾点</strong>
                    <div className="memory-bullet-list">
                      {contradictionItems.slice(0, 5).map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="empty-box">当前尚未识别出明显的程序风险或待补强项。</div>
            )}
          </div>
        </div>

        <div className="insight-card">
          <div className="preview-section-head">
            <strong>争议焦点支持矩阵</strong>
            <span>{supportMatrix.length} 项</span>
          </div>
          {supportMatrix.length ? (
            <div className="memory-matrix-list">
              {supportMatrix.map((item, index) => (
                <article className="memory-matrix-card" key={`${index + 1}-${item.fact}`}>
                  <strong>{item.fact}</strong>
                  <div className="knowledge-chip-row memory-chip-row">
                    {item.evidenceNumbers.map((number) => {
                      const evidence = caseEvidences.find((entry) => entry.number === number) ?? null
                      return (
                        <button
                          key={`${item.fact}-${number}`}
                          className="memory-evidence-chip"
                          type="button"
                          onClick={() => {
                            if (evidence) {
                              handlePreviewEvidenceItem(evidence)
                            }
                          }}
                        >
                          {number}
                          {evidence ? ` · ${evidence.name}` : ''}
                        </button>
                      )
                    })}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-box">当前还没有形成争议焦点与证据的支持矩阵。</div>
          )}
        </div>

        <div className="insight-card">
          <div className="preview-section-head">
            <strong>文书段落对应的记忆来源</strong>
            <span>{paragraphMemoryCards.length} 段</span>
          </div>
          {paragraphMemoryCards.length ? (
            <div className="memory-paragraph-list">
              {paragraphMemoryCards.map((item) => (
                <article
                  className={`memory-paragraph-card ${item.isActive ? 'active' : ''}`}
                  key={item.paragraph.id}
                  onClick={() => focusParagraph(item.paragraph.id)}
                >
                  <div className="memory-paragraph-head">
                    <strong>第 {item.paragraphIndex} 段</strong>
                    <span>{item.paragraph.verified ? '已核验' : '待复核'}</span>
                  </div>
                  <p className="memory-paragraph-text">{item.paragraph.text}</p>

                  <div className="memory-source-grid">
                    <div className="knowledge-detail-block">
                      <strong>写作意图</strong>
                      <p>{item.paragraphPlan?.intent || '当前段落尚未沉淀明确的写作意图记忆。'}</p>
                    </div>

                    <div className="knowledge-detail-block">
                      <strong>命中的案件记忆</strong>
                      {item.supportFacts.length ? (
                        <div className="memory-bullet-list">
                          {item.supportFacts.slice(0, 3).map((supportItem) => (
                            <span key={`${item.paragraph.id}-${supportItem.fact}`}>{supportItem.fact}</span>
                          ))}
                        </div>
                      ) : (
                        <p>当前段落尚未命中案件支持矩阵中的明确事实项。</p>
                      )}
                    </div>
                  </div>

                  <div className="memory-source-list">
                    {item.evidenceInsightSources.length ? (
                      item.evidenceInsightSources.map(({ evidence, insight }) => (
                        <button
                          className="memory-source-card"
                          key={`${item.paragraph.id}-${evidence.id}`}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            handlePreviewEvidenceItem(evidence)
                          }}
                        >
                          <div className="memory-source-head">
                            <strong>{evidence.number} {evidence.name}</strong>
                            <span>{insight?.status === 'ready' ? '已理解' : insight?.status === 'failed' ? '理解失败' : '待理解'}</span>
                          </div>
                          <p>{insight?.summary || evidence.summaryText || '当前证据尚未形成结构化记忆摘要。'}</p>
                        </button>
                      ))
                    ) : (
                      <div className="empty-box">当前段落还没有绑定证据，因此没有可追溯的记忆来源。</div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-box">请先生成文书，系统才会展示段落级记忆来源。</div>
          )}
        </div>
      </div>
    )
  }

  function renderVerifyInsightPanel() {
    if (verifyInsightTab === 'evidence') {
      return renderEvidencePreview()
    }

    if (verifyInsightTab === 'statute') {
      return renderStatuteReferencePanel()
    }

    if (verifyInsightTab === 'memory') {
      return renderMemoryPanel()
    }

    return renderCaseReferencePanel()
  }

  function renderKnowledgeCenter() {
    const relatedCasesForStatute = selectedStatute
      ? filteredKnowledgeCases
          .filter(
            (entry) =>
              entry.referencedStatutes.some(
                (item) => item.includes(selectedStatute.title) || selectedStatute.title.includes(item),
              )
              || entry.keywords.some((item) => selectedStatute.keywords.includes(item)),
          )
          .slice(0, 3)
      : []

    return (
      <section className="knowledge-layout">
        <article className="panel pro-card knowledge-search-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">专业知识库</span>
              <h2>
                {knowledgeTab === 'cases'
                  ? '法院案例库'
                  : knowledgeTab === 'statutes'
                    ? '法律条文库'
                    : '我的引用'}
              </h2>
            </div>
            <div className="tab-row knowledge-tab-row">
              {[
                ['cases', '法院案例库'],
                ['statutes', '法律条文库'],
                ['saved', '我的引用'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={knowledgeTab === key ? 'active' : ''}
                  type="button"
                  onClick={() => setKnowledgeTab(key as KnowledgeTab)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <input
            className="search-input"
            value={knowledgeKeyword}
            onChange={(event) => setKnowledgeKeyword(event.target.value)}
            placeholder={
              knowledgeTab === 'statutes'
                ? '输入法律名称、法条编号、关键词'
                : knowledgeTab === 'cases'
                  ? '输入案由、争议焦点、案号、关键词'
                  : '查看当前段落已绑定的法条与案例'
            }
          />

          <div className="knowledge-context-card">
            <strong>当前检索上下文</strong>
            <span>{knowledgeContext || '当前尚未选择案件段落，将显示全部知识库内容。'}</span>
          </div>

          {knowledgeTab === 'cases' ? (
            <div className="knowledge-list">
              {filteredKnowledgeCases.map((entry) => (
                <button
                  key={entry.id}
                  className={`knowledge-item ${selectedKnowledgeCase?.id === entry.id ? 'active' : ''}`}
                  type="button"
                  onClick={() => setSelectedKnowledgeCaseId(entry.id)}
                >
                  <strong>{entry.title}</strong>
                  <span>{entry.courtName} · {entry.caseNumber}</span>
                  <div className="knowledge-chip-row">
                    <span className="knowledge-chip">{entry.cause}</span>
                    <span className="knowledge-chip">{entry.trialLevel}</span>
                    <span className="knowledge-chip">{entry.region}</span>
                  </div>
                  <p>{entry.holdingSummary}</p>
                </button>
              ))}
            </div>
          ) : null}

          {knowledgeTab === 'statutes' ? (
            <div className="knowledge-list">
              {filteredKnowledgeStatutes.map((entry) => (
                <button
                  key={entry.id}
                  className={`knowledge-item ${selectedStatute?.id === entry.id ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setSelectedStatuteId(entry.id)
                    setSelectedArticleId(entry.articles[0]?.id ?? null)
                  }}
                >
                  <strong>{entry.title}</strong>
                  <span>{entry.docType} · {entry.version}</span>
                  <div className="knowledge-chip-row">
                    <span className="knowledge-chip">{getEffectiveStatusLabel(entry.effectiveStatus)}</span>
                    <span className="knowledge-chip">{entry.issuer}</span>
                  </div>
                  <p>{entry.keywords.join(' / ') || '暂未补充关键词'}</p>
                </button>
              ))}
            </div>
          ) : null}

          {knowledgeTab === 'saved' ? (
            <div className="knowledge-reference-list">
              {activeParagraphReferences.length ? (
                activeParagraphReferences.map((reference, index) => (
                  <article className="knowledge-reference-card" key={getReferenceKey(reference, index)}>
                    <div>
                      <strong>{reference.sourceTitle}</strong>
                      <span>{reference.label}</span>
                    </div>
                    <p>{reference.quote}</p>
                    <div className="inline-actions">
                      <span>{reference.locator}</span>
                      <div>
                        <span
                          className="text-link danger"
                          onClick={() => {
                            void handleRemoveKnowledgeReference(reference.id ?? getReferenceKey(reference, index))
                          }}
                        >
                          移除
                        </span>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-box">当前段落还没有绑定法条或案例引用。</div>
              )}
            </div>
          ) : null}
        </article>

        <article className="panel pro-card knowledge-detail-panel">
          {knowledgeTab === 'cases' ? (
            selectedKnowledgeCase ? (
              <>
                <div className="panel-header">
                  <div>
                    <span className="eyebrow">裁判基础信息</span>
                    <h2>{selectedKnowledgeCase.title}</h2>
                  </div>
                  <span className="status-chip ready">{selectedKnowledgeCase.courtName}</span>
                </div>

                <div className="knowledge-meta-grid">
                  <div><span>案号</span><strong>{selectedKnowledgeCase.caseNumber}</strong></div>
                  <div><span>案由</span><strong>{selectedKnowledgeCase.cause}</strong></div>
                  <div><span>审级</span><strong>{selectedKnowledgeCase.trialLevel}</strong></div>
                  <div><span>裁判日期</span><strong>{formatDateTime(selectedKnowledgeCase.judgmentDate)}</strong></div>
                </div>

                <div className="knowledge-detail-block">
                  <strong>争议焦点</strong>
                  <p>{selectedKnowledgeCase.issueSummary}</p>
                </div>
                <div className="knowledge-detail-block">
                  <strong>裁判要旨</strong>
                  <p>{selectedKnowledgeCase.holdingSummary}</p>
                </div>
                <div className="knowledge-detail-block">
                  <strong>裁判理由</strong>
                  <p>{selectedKnowledgeCase.reasoningSummary}</p>
                </div>
                <div className="knowledge-detail-block">
                  <strong>援引法条</strong>
                  <div className="knowledge-chip-row">
                    {selectedKnowledgeCase.referencedStatutes.length ? (
                      selectedKnowledgeCase.referencedStatutes.map((item) => (
                        <span className="knowledge-chip" key={item}>{item}</span>
                      ))
                    ) : (
                      <span className="knowledge-chip">暂未建立法条关联</span>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-box">暂无匹配案例</div>
            )
          ) : null}

          {knowledgeTab === 'statutes' ? (
            selectedStatute ? (
              <>
                <div className="panel-header">
                  <div>
                    <span className="eyebrow">法律文件信息</span>
                    <h2>{selectedStatute.title}</h2>
                  </div>
                  <span className="status-chip ready">{getEffectiveStatusLabel(selectedStatute.effectiveStatus)}</span>
                </div>

                <div className="knowledge-meta-grid">
                  <div><span>文种</span><strong>{selectedStatute.docType}</strong></div>
                  <div><span>发布机关</span><strong>{selectedStatute.issuer}</strong></div>
                  <div><span>文件版本</span><strong>{selectedStatute.version}</strong></div>
                  <div><span>生效日期</span><strong>{formatDateTime(selectedStatute.effectiveDate)}</strong></div>
                </div>

                <div className="knowledge-detail-block">
                  <strong>检索关键词</strong>
                  <div className="knowledge-chip-row">
                    {selectedStatute.keywords.map((item) => (
                      <span className="knowledge-chip" key={item}>{item}</span>
                    ))}
                  </div>
                </div>

                <div className="knowledge-article-list">
                  {selectedStatute.articles.map((article) => (
                    <button
                      key={article.id}
                      className={`knowledge-article-item ${selectedStatuteArticle?.id === article.id ? 'active' : ''}`}
                      type="button"
                      onClick={() => setSelectedArticleId(article.id)}
                    >
                      <strong>{article.articleNumber}</strong>
                      <span>{article.topicTags.join(' / ')}</span>
                    </button>
                  ))}
                </div>

                {selectedStatuteArticle ? (
                  <div className="knowledge-detail-block">
                    <strong>{selectedStatuteArticle.articleNumber}</strong>
                    <p>{selectedStatuteArticle.content}</p>
                    <div className="inline-actions">
                      <span>{selectedStatuteArticle.aliases.join(' / ')}</span>
                      <div>
                        <span
                          className="text-link"
                          onClick={() => {
                            void handleBindStatute(selectedStatuteArticle, selectedStatute)
                          }}
                        >
                          绑定到当前段落
                        </span>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="empty-box">暂无匹配法条</div>
            )
          ) : null}

          {knowledgeTab === 'saved' ? (
            <div className="knowledge-stack">
              <div className="knowledge-context-card">
                <strong>当前段落</strong>
                <span>{activeParagraph?.text ?? '请先在核验编辑中选择段落。'}</span>
              </div>
              <div className="knowledge-detail-block">
                <strong>引用说明</strong>
                <p>这里展示当前段落已经绑定的法律条文与类案片段。删除引用后，会同步从核验工作台的段落支撑中移除。</p>
              </div>
            </div>
          ) : null}
        </article>

        <article className="panel pro-card knowledge-fragment-panel">
          {knowledgeTab === 'cases' ? (
            selectedKnowledgeCase ? (
              <>
                <div className="panel-header">
                  <div>
                    <span className="eyebrow">可引用裁判片段</span>
                    <h2>片段级说理支撑</h2>
                  </div>
                  <span className="status-chip ready">{selectedKnowledgeCase.excerpts.length} 条片段</span>
                </div>
                <div className="knowledge-reference-list">
                  {selectedKnowledgeCase.excerpts.map((excerpt) => (
                    <article className="knowledge-reference-card" key={excerpt.id}>
                      <div>
                        <strong>{excerpt.summary}</strong>
                        <span>{excerpt.locator}</span>
                      </div>
                      <p>{excerpt.content}</p>
                      <div className="inline-actions">
                        <span>{excerpt.keywords.join(' / ') || '裁判观点摘录'}</span>
                        <div>
                          <span
                            className="text-link"
                            onClick={() => {
                              void handleBindCaseExcerpt(excerpt, selectedKnowledgeCase)
                            }}
                          >
                            绑定到当前段落
                          </span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-box">请选择左侧案例后查看可引用片段。</div>
            )
          ) : null}

          {knowledgeTab === 'statutes' ? (
            selectedStatute ? (
              <>
                <div className="panel-header">
                  <div>
                    <span className="eyebrow">可引用条文片段</span>
                    <h2>{selectedStatuteArticle?.articleNumber ?? '请选择具体条文'}</h2>
                  </div>
                  <span className="status-chip ready">{selectedStatute.articles.length} 条</span>
                </div>
                {selectedStatuteArticle ? (
                  <div className="knowledge-stack">
                    <div className="knowledge-detail-block">
                      <strong>{selectedStatuteArticle.articleNumber}</strong>
                      <p>{selectedStatuteArticle.content}</p>
                      <div className="inline-actions">
                        <span>{selectedStatute.sourceAuthority ?? selectedStatute.issuer}</span>
                        <div>
                          {selectedStatute.sourceTextUrl
                            || selectedStatute.sourcePdfUrl
                            || selectedStatute.sourceUrl ? (
                            <a
                              className="text-link viewer-link"
                              href={selectedStatute.sourceTextUrl ?? selectedStatute.sourcePdfUrl ?? selectedStatute.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              官方原文
                            </a>
                          ) : null}
                          <span
                            className="text-link"
                            onClick={() => {
                              void handleBindStatute(selectedStatuteArticle, selectedStatute)
                            }}
                          >
                            绑定到当前段落
                          </span>
                        </div>
                      </div>
                    </div>
                    {selectedKnowledgeInterpretations.length ? (
                      <div className="knowledge-detail-block">
                        <strong>相关司法解释</strong>
                        <div className="knowledge-reference-list">
                          {selectedKnowledgeInterpretations.map(({ document, article }) => (
                            <article className="knowledge-reference-card" key={`${document.id}-${article.id}`}>
                              <div>
                                <strong>{document.title} {article.articleNumber}</strong>
                                <span>{document.docType} · {document.version}</span>
                              </div>
                              <p>{article.content}</p>
                              <div className="inline-actions">
                                <span>{document.issuer}</span>
                                <div>
                                  {document.sourceTextUrl || document.sourcePdfUrl || document.sourceUrl ? (
                                    <a
                                      className="text-link viewer-link"
                                      href={document.sourceTextUrl ?? document.sourcePdfUrl ?? document.sourceUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      官方原文
                                    </a>
                                  ) : null}
                                  <span
                                    className="text-link"
                                    onClick={() => {
                                      void handleBindStatute(article, document)
                                    }}
                                  >
                                    绑定到当前段落
                                  </span>
                                </div>
                              </div>
                            </article>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="knowledge-detail-block">
                      <strong>相关类案推荐</strong>
                      <div className="knowledge-reference-list">
                        {(relatedCasesForStatute.length ? relatedCasesForStatute : recommendedKnowledgeCases.slice(0, 3)).map((entry) => (
                          <article className="knowledge-reference-card" key={entry.id}>
                            <div>
                              <strong>{entry.title}</strong>
                              <span>{entry.courtName} · {entry.caseNumber}</span>
                            </div>
                            <p>{entry.holdingSummary}</p>
                            <div className="inline-actions">
                              <span>{entry.cause}</span>
                              <div>
                                <span
                                  className="text-link"
                                  onClick={() => {
                                    setKnowledgeTab('cases')
                                    void handleOpenKnowledgeCaseDetail(entry)
                                  }}
                                >
                                  查看案例
                                </span>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="empty-box">请先在中栏选择具体条文后再绑定。</div>
                )}
              </>
            ) : (
              <div className="empty-box">请选择左侧法律文件后查看条文片段。</div>
            )
          ) : null}

          {knowledgeTab === 'saved' ? (
            <div className="knowledge-stack">
              <div className="panel-header">
                <div>
                  <span className="eyebrow">已绑定引用</span>
                  <h2>当前段落论证支撑</h2>
                </div>
                <span className="status-chip ready">{activeParagraphReferences.length} 条</span>
              </div>
              {activeParagraphReferences.length ? (
                activeParagraphReferences.map((reference, index) => (
                  <article className="knowledge-reference-card" key={getReferenceKey(reference, index)}>
                    <div>
                      <strong>{reference.sourceTitle}</strong>
                      <span>{reference.label}</span>
                    </div>
                    <p>{reference.quote}</p>
                    <div className="inline-actions">
                      <span>{reference.locator}</span>
                      <div>
                        <span
                          className="text-link danger"
                          onClick={() => {
                            void handleRemoveKnowledgeReference(reference.id ?? getReferenceKey(reference, index))
                          }}
                        >
                          移除
                        </span>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-box">当前段落还没有绑定法条或案例引用。</div>
              )}
            </div>
          ) : null}
        </article>
      </section>
    )
  }

  function renderDocumentModeToolbar() {
    const activeParagraphEditor = activeParagraphId ? paragraphEditorsRef.current[activeParagraphId] ?? null : null

    type ToolbarItem = {
      key: string
      label: string
      title?: string
      active?: boolean
      action: (editor: Editor) => boolean
    }

    type ToolbarGroup = {
      key: string
      items: ToolbarItem[]
    }

    const runEditorCommand = (command: (editor: Editor) => void) => {
      if (!activeParagraphEditor) {
        return
      }

      command(activeParagraphEditor)
      setEditorToolbarVersion((current) => current + 1)
    }

    const toolbarGroups: ToolbarGroup[] = [
      {
        key: 'history',
        items: [
          {
            key: 'undo',
            label: '↶',
            title: '撤销',
            action: (editor: Editor) => editor.chain().focus().undo().run(),
          },
          {
            key: 'redo',
            label: '↷',
            title: '重做',
            action: (editor: Editor) => editor.chain().focus().redo().run(),
          },
        ],
      },
      {
        key: 'heading',
        items: [
          {
            key: 'h1',
            label: 'H1',
            active: activeParagraphEditor?.isActive('heading', { level: 1 }) ?? false,
            action: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
          },
          {
            key: 'h2',
            label: 'H2',
            active: activeParagraphEditor?.isActive('heading', { level: 2 }) ?? false,
            action: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          },
          {
            key: 'h3',
            label: 'H3',
            active: activeParagraphEditor?.isActive('heading', { level: 3 }) ?? false,
            action: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
          },
          {
            key: 'paragraph',
            label: '正文',
            active: activeParagraphEditor?.isActive('paragraph') ?? false,
            action: (editor: Editor) => editor.chain().focus().setParagraph().run(),
          },
        ],
      },
      {
        key: 'style',
        items: [
          {
            key: 'bold',
            label: 'B',
            active: activeParagraphEditor?.isActive('bold') ?? false,
            action: (editor: Editor) => editor.chain().focus().toggleBold().run(),
          },
          {
            key: 'italic',
            label: 'I',
            active: activeParagraphEditor?.isActive('italic') ?? false,
            action: (editor: Editor) => editor.chain().focus().toggleItalic().run(),
          },
          {
            key: 'underline',
            label: 'U',
            active: activeParagraphEditor?.isActive('underline') ?? false,
            action: (editor: Editor) => editor.chain().focus().toggleUnderline().run(),
          },
        ],
      },
      {
        key: 'align',
        items: [
          {
            key: 'align-left',
            label: '≡',
            title: '左对齐',
            active: activeParagraphEditor?.isActive({ textAlign: 'left' }) ?? false,
            action: (editor: Editor) => editor.chain().focus().setTextAlign('left').run(),
          },
          {
            key: 'align-center',
            label: '≣',
            title: '居中对齐',
            active: activeParagraphEditor?.isActive({ textAlign: 'center' }) ?? false,
            action: (editor: Editor) => editor.chain().focus().setTextAlign('center').run(),
          },
          {
            key: 'align-right',
            label: '☰',
            title: '右对齐',
            active: activeParagraphEditor?.isActive({ textAlign: 'right' }) ?? false,
            action: (editor: Editor) => editor.chain().focus().setTextAlign('right').run(),
          },
        ],
      },
      {
        key: 'insert',
        items: [
          {
            key: 'page-break',
            label: '分页',
            action: (editor: Editor) => editor.chain().focus().setHorizontalRule().run(),
          },
        ],
      },
    ]

    return (
      <div className="word-toolbar" data-toolbar-version={editorToolbarVersion}>
        <div className="word-toolbar-main">
          {toolbarGroups.map((group, groupIndex) => (
            <div className="word-toolbar-group" key={group.key}>
              {group.items.map((item) => (
                <button
                  key={item.key}
                  className={`word-tool ${item.active ? 'active' : ''} ${item.key === 'paragraph' ? 'label-tool' : ''}`}
                  type="button"
                  title={item.title ?? item.label}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runEditorCommand(item.action)}
                >
                  {item.label}
                </button>
              ))}
              {groupIndex < toolbarGroups.length - 1 ? <span className="word-toolbar-divider" /> : null}
            </div>
          ))}
        </div>
        <div className="word-toolbar-side">
          <div className="word-toolbar-side-main">
            <div className="word-toolbar-group compact">
              <button
                className="word-tool evidence-link-button"
                type="button"
                onClick={() => void handleAutoLinkCertificate()}
                disabled={!activeCertificate || isSubmitting || isAutoLinkingActiveCertificate}
              >
                {autoLinkingCertificateId === activeCertificate?.id ? '联动中...' : '证据联动'}
              </button>
            </div>
            <span className="toolbar-paragraph-status">
              {activeParagraphOrder ? `当前编辑：第 ${activeParagraphOrder} 段` : '请先选择段落'}
            </span>
          </div>
          <div className="word-toolbar-meta">
            <span className={`auto-link-feedback ${linkageStatusMessage.tone}`} role="status" aria-live="polite" aria-atomic="true">
              {isAutoLinkingActiveCertificate ? <span className="linkage-progress-spinner" aria-hidden="true" /> : null}
              <span className="linkage-progress-viewport">
                <span
                  key={linkageStatusMessage.text}
                  className={isAutoLinkingActiveCertificate ? 'linkage-progress-text is-rolling' : 'linkage-progress-text'}
                >
                  {linkageStatusMessage.text}
                </span>
              </span>
            </span>
          </div>
        </div>
      </div>
    )
  }

  function renderCertificateEditor() {
    if (streamingCertificatePreview) {
      return (
        <section className="word-editor-shell">
          <div className="word-canvas">
            <article className="word-page">
              <header className="word-page-header">
                <h3>{streamingCertificatePreview.title || (streamingCertificatePreview.mode === 'rewrite' ? '正在改写文书...' : '正在生成文书...')}</h3>
                <div className="word-document-meta">
                  <span>案件：{selectedCase?.name ?? '未命名案件'}</span>
                  <span>{streamingCertificatePreview.mode === 'rewrite' ? '状态：改写中...' : '状态：生成中...'}</span>
                  <span>已输出段落：{streamingCertificatePreview.paragraphs.length}</span>
                </div>
              </header>

              <div className="word-document-body">
                {streamingCertificatePreview.paragraphs.length ? (
                  streamingCertificatePreview.paragraphs.map((paragraph) => (
                    <section key={paragraph.id} className="word-paragraph streaming-preview">
                      <div className="streaming-paragraph-content">
                        <p>{paragraph.text}</p>
                      </div>
                    </section>
                  ))
                ) : (
                  <div className="empty-box">正在生成内容...</div>
                )}
              </div>
            </article>
          </div>
        </section>
      )
    }

    if (!activeCertificate) {
      return (
        <section className="word-editor-shell">
          <div className="word-canvas word-canvas-empty" />
        </section>
      )
    }

    return (
      <section className="word-editor-shell">
        {renderDocumentModeToolbar()}
        <div className="word-canvas">
          <article className="word-page">
            <header className="word-page-header">
              <h3>{activeCertificate.title}</h3>
              <div className="word-document-meta">
                <span>案件：{selectedCase?.name ?? '未命名案件'}</span>
                <span>生成时间：{formatDateTime(activeCertificate.createdAt)}</span>
                <span>核验段落：{activeCertificate.paragraphs.length}</span>
              </div>
            </header>

            <div className="word-document-body">
              {activeCertificate.paragraphs.map((paragraph) => {
                const paragraphLinks = getParagraphLinks(paragraph)
                const paragraphReferences = getParagraphReferences(paragraph)
                const paragraphStatutes = paragraphReferences.filter((item) => item.type === 'statute')
                const paragraphCases = paragraphReferences.filter((item) => item.type === 'case')
                const linkedEvidences = getParagraphEvidences(paragraph)
                const paragraphKnowledgeReferences = [
                  ...paragraphStatutes.map((reference) => ({
                    key: `statute-${getReferenceIdentity(reference)}`,
                    label: `[法${reference.locator}]`,
                    tone: 'statute' as const,
                    active:
                      paragraph.id === activeParagraph?.id
                      && verifyInsightTab === 'statute'
                      && selectedKnowledgeReferenceId === getReferenceIdentity(reference),
                    onClick: () => {
                      handlePreviewKnowledgeReference(paragraph.id, reference)
                    },
                  })),
                  ...paragraphCases.map((reference) => ({
                    key: `case-${getReferenceIdentity(reference)}`,
                    label: `[案${reference.locator}]`,
                    tone: 'case' as const,
                    active:
                      paragraph.id === activeParagraph?.id
                      && verifyInsightTab === 'case'
                      && selectedKnowledgeReferenceId === getReferenceIdentity(reference),
                    onClick: () => {
                      handlePreviewKnowledgeReference(paragraph.id, reference)
                    },
                  })),
                ]

                return (
                  <section
                    key={paragraph.id}
                    className={`word-paragraph ${paragraph.id === activeParagraph?.id ? 'active' : ''} ${paragraph.verified ? 'verified' : ''}`}
                    onClick={() => {
                      if (paragraph.id !== activeParagraph?.id) {
                        focusParagraph(paragraph.id)
                      }
                    }}
                  >
                    <div className="word-paragraph-layout">
                      <ParagraphRichEditor
                        key={draftKey(loginAccount, activeCertificate.id, paragraph.id)}
                        paragraph={paragraph}
                        account={loginAccount}
                        certificateId={activeCertificate.id}
                        editable={!isAutoLinkingActiveCertificate}
                        active={paragraph.id === activeParagraph?.id}
                        activeSentenceIndex={paragraph.id === activeParagraph?.id ? activeSentenceSelection.index : null}
                        inlineReferences={paragraphKnowledgeReferences}
                        onActivate={() => {
                          setActiveParagraphId(paragraph.id)
                        }}
                        onActivateSentence={(sentenceIndex, sentenceText, userInitiated) => {
                          setActiveParagraphId(paragraph.id)
                          syncActiveSentence(paragraph, {
                            sentenceIndex,
                            sentenceText,
                          }, { syncInsight: Boolean(userInitiated) || !manualPreviewEvidenceIdRef.current })
                        }}
                        onCommit={(patch, expected) => handleUpdateParagraphById(paragraph.id, patch, true, expected)}
                        onRegisterEditor={(editor) => {
                          paragraphEditorsRef.current[paragraph.id] = editor
                        }}
                        onEditorStateChange={() => {
                          setEditorToolbarVersion((current) => current + 1)
                        }}
                      />

                      {paragraphLinks.length ? (
                        <aside className="paragraph-evidence-sidebar" aria-label="本段源证据批注">
                          <div className="paragraph-comment-rail">
                            {paragraphLinks.map((link, linkIndex) => {
                              const evidence = linkedEvidences.find((item) => item.id === link.evidenceId)
                              const isActiveEvidenceReference =
                                paragraph.id === activeParagraph?.id
                                && verifyInsightTab === 'evidence'
                                && linkIndex === activeReferenceIndex

                              return (
                                <button
                                  key={`comment-${getLinkKey(link, linkIndex)}`}
                                  className={`paragraph-comment-chip ${link.relation ?? 'support'} ${isActiveEvidenceReference ? 'active' : ''}`}
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handlePreviewEvidenceReference(paragraph.id, linkIndex)
                                  }}
                                  title={[evidence ? `${evidence.number} ${evidence.name}` : `材料 ${linkIndex + 1}`, link.reason].filter(Boolean).join('：')}
                                >
                                  {evidence ? `证${evidence.number}` : `证${linkIndex + 1}`}
                                  {link.relation === 'contradict' ? ' · 矛盾' : link.relation === 'context' ? ' · 线索' : ''}
                                </button>
                              )
                            })}
                          </div>
                        </aside>
                      ) : null}
                    </div>
                  </section>
                )
              })}
            </div>

            <footer className="word-page-footer">
              <span>{selectedCase?.name ?? '案件文稿'}</span>
              <span>第 1 页</span>
            </footer>
          </article>
        </div>
      </section>
    )
  }

  function renderAppUpdateCard(compact = false) {
    if (!isDesktopClient) {
      return null
    }

    const latestRelease = appUpdateState.latestRelease
    const hasAvailableUpdate = latestRelease && compareAppVersions(__APP_VERSION__, latestRelease.version) < 0
    const title = hasAvailableUpdate
      ? `发现新版本 v${latestRelease.version}`
      : `当前版本 v${__APP_VERSION__}`
    const detail = appUpdateState.message
      || (hasAvailableUpdate
        ? `最新安装包 ${latestRelease?.sizeLabel ?? ''}，可直接开始更新。`
        : '可手动检查更新，确保客户端保持最新。')

    return (
      <div className={`app-update-card ${compact ? 'compact' : ''} ${hasAvailableUpdate ? 'available' : ''}`}>
        <div className="app-update-copy">
          <span>桌面端更新</span>
          <strong>{title}</strong>
          <p>{detail}</p>
        </div>

        {appUpdateState.status === 'downloading' ? (
          <div className="app-update-progress">
            <div className="app-update-progress-bar" aria-hidden="true">
              <span style={{ width: `${appUpdateState.progress ?? 8}%` }} />
            </div>
            <strong>{appUpdateState.progress ? `${appUpdateState.progress}%` : '下载中'}</strong>
          </div>
        ) : null}

        <div className="app-update-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={() => void checkForAppUpdate()}
            disabled={appUpdateState.status === 'checking' || appUpdateState.status === 'downloading'}
          >
            {appUpdateState.status === 'checking' ? '检查中...' : '检查更新'}
          </button>
          {hasAvailableUpdate ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => void handleStartAppUpdate()}
              disabled={appUpdateState.status === 'downloading'}
            >
              {appUpdateState.status === 'downloading' ? '正在更新...' : '一键更新'}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  function renderSidebarFooter(compact = false) {
    return (
      <div className={`sidebar-footer ${compact ? 'sidebar-footer-compact' : ''}`}>
        {!compact ? (
          <>
            <div className="sidebar-footer-points">
              <div className="points-card sidebar-points-card">
                <span>积分余额</span>
                <strong>{appState!.user.points}</strong>
              </div>
              <button className="primary-button sidebar-recharge-button" type="button" onClick={handleRecharge} disabled={isSubmitting}>
                充值
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="sidebar-footer-points sidebar-footer-points-compact">
              <div className="points-card sidebar-points-card sidebar-points-card-compact">
                <span>积分余额</span>
                <strong>{appState!.user.points}</strong>
              </div>
              <button className="primary-button sidebar-recharge-button sidebar-recharge-button-compact" type="button" onClick={handleRecharge} disabled={isSubmitting}>
                充值
              </button>
            </div>
          </>
        )}
        <div className="sidebar-footer-account-row">
          <div className="sidebar-footer-account">
            <strong>{sidebarPrimaryIdentity}</strong>
          </div>
          <button
            className="ghost-button sidebar-feedback-button"
            type="button"
            onClick={handleOpenFeedbackDialog}
            disabled={isSubmitting}
          >
            反馈
          </button>
          <button
            className="ghost-button sidebar-logout-button"
            type="button"
            onClick={handleLogout}
            title="退出登录"
            aria-label="退出登录"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M11 3.75A2.75 2.75 0 0 1 13.75 1h2.5A2.75 2.75 0 0 1 19 3.75v12.5A2.75 2.75 0 0 1 16.25 19h-2.5A2.75 2.75 0 0 1 11 16.25V14.5a.75.75 0 0 1 1.5 0v1.75c0 .69.56 1.25 1.25 1.25h2.5c.69 0 1.25-.56 1.25-1.25V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25V5.5a.75.75 0 0 1-1.5 0V3.75ZM8.78 6.47a.75.75 0 0 1 0 1.06L6.31 10H14.5a.75.75 0 0 1 0 1.5H6.31l2.47 2.47a.75.75 0 1 1-1.06 1.06l-3.75-3.75a.75.75 0 0 1 0-1.06l3.75-3.75a.75.75 0 0 1 1.06 0Z"
                fill="currentColor"
              />
            </svg>
            <span>退出登录</span>
          </button>
        </div>
      </div>
    )
  }

  function renderStreamlinedEvidenceItem(evidence: Evidence) {
    return (
      <div
        className={`streamlined-evidence-item ${selectedEvidenceIds.includes(evidence.id) ? 'active' : ''} ${manualPreviewEvidenceId === evidence.id ? 'previewing' : ''}`}
        key={evidence.id}
        onClick={() => {
          handlePreviewEvidenceItem(evidence)
        }}
        title="点击预览原件"
      >
        <input
          checked={selectedEvidenceIds.includes(evidence.id)}
          type="checkbox"
          onClick={(event) => event.stopPropagation()}
          onChange={() => toggleEvidenceSelection(evidence.id)}
        />
        <div>
          <div className="streamlined-evidence-title-row">
            <strong title={getEvidenceDisplayFileName(evidence)}>{getEvidenceDisplayFileName(evidence)}</strong>
            <span className="type-badge compact-type-badge">{getEvidenceExtension(evidence.fileName)}</span>
          </div>
          <span className="streamlined-evidence-number">{evidence.number}</span>
        </div>
      </div>
    )
  }

  function renderEvidenceTreeRow(row: EvidenceTreeRow) {
    return row.evidence
      ? <div style={{ marginLeft: Math.min(row.depth * 14, 56), paddingBottom: 8 }}>
          {renderStreamlinedEvidenceItem(row.evidence)}
        </div>
      : <div className="streamlined-folder-node-label"
          style={{ '--folder-depth': Math.min(row.depth, 4), paddingBottom: 8 } as CSSProperties}>
          <span>{row.label}</span>
        </div>
  }

  function renderCertificateVersionList(targetTab: CaseCenterTab) {
    if (!caseCertificates.length) {
      return <div className="empty-box">当前案件还没有质证书版本。</div>
    }

    return (
      <div className="certificate-list">
        {caseCertificates.map((certificate) => (
          <button
            key={certificate.id}
            className={`certificate-item ${certificate.id === activeCertificate?.id ? 'active' : ''}`}
            type="button"
            onClick={() => {
              handleSelectCertificate(certificate.id)
              openCaseCenter(targetTab)
            }}
          >
            <div className="case-item-top">
              <strong>{certificate.title}</strong>
              <span className="status-chip ready">{certificate.role === 'plaintiff' ? '原告' : '被告'}</span>
            </div>
            <span>{formatDateTime(certificate.createdAt)}</span>
            <div className="inline-actions">
              <span>{certificate.paragraphs.length} 段质证意见</span>
              <div>
                <span className="text-link">打开</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    )
  }

  function renderWorkbenchSidebar() {
    return (
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="eyebrow">LawVerify</span>
          <h2>工作台</h2>
          <p>查看案件全局进展、当前任务与近期工作入口。</p>
        </div>

        <div className="panel pro-card sidebar-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">近期案件</span>
              <h2>继续处理</h2>
            </div>
          </div>
          <div className="case-list">
            {recentCases.map((caseFolder) => (
              <button
                key={caseFolder.id}
                className={`case-item ${caseFolder.id === selectedCaseId ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  handleSelectCase(caseFolder.id)
                  openCaseCenter('overview')
                }}
              >
                <div className="case-item-top">
                  <strong>{caseFolder.name}</strong>
                  <span className={`status-chip ${caseFolder.status}`}>{getStatusLabel(caseFolder.status)}</span>
                </div>
                <span>{formatDateTime(caseFolder.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>

        {renderSidebarFooter()}
      </aside>
    )
  }

  function renderKnowledgeSidebar() {
    return (
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="eyebrow">LawVerify</span>
          <h2>知识库</h2>
          <p>沉淀法院案例、法律条文与当前案件的引用上下文。</p>
        </div>

        <div className="panel pro-card sidebar-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">当前视图</span>
              <h2>
                {knowledgeTab === 'cases'
                  ? '法院案例库'
                  : knowledgeTab === 'statutes'
                    ? '法律条文库'
                    : '我的引用'}
              </h2>
            </div>
          </div>
          <p className="sidebar-copy">
            主内容区负责知识库的唯一主切换入口，左侧这里只保留当前视图说明与数据概况，避免同层级导航重复。
          </p>
          <div className="sidebar-stat-grid">
            <article>
              <span>案例</span>
              <strong>{appState!.knowledgeCases.length}</strong>
            </article>
            <article>
              <span>法条</span>
              <strong>{appState!.knowledgeStatutes.length}</strong>
            </article>
          </div>
        </div>

        <div className="panel pro-card sidebar-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">当前上下文</span>
              <h2>{selectedCase?.name ?? '未选择案件'}</h2>
            </div>
          </div>
          <p className="sidebar-copy">{knowledgeContext || '当前没有段落上下文，将显示全部知识库内容。'}</p>
          <div className="tab-row sidebar-action-row">
            <button type="button" onClick={() => openCaseCenter('review')}>回到核验定稿</button>
            <button type="button" onClick={() => openCaseCenter('draft')}>回到质证起草</button>
          </div>
        </div>

        {renderSidebarFooter()}
      </aside>
    )
  }

  function renderSettingsSidebar(showFooter = true) {
    return (
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="eyebrow">LawVerify</span>
          <h2>法律知识库</h2>
          <p>统一管理法律文件、司法解释与上传的知识文件，并展示抽取和向量化状态。</p>
        </div>

        <div className="panel pro-card sidebar-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">当前模块</span>
              <h2>知识文件配置</h2>
            </div>
          </div>
          {settingsTab === 'files' ? (
            <>
              <p className="sidebar-copy">
                左侧只保留上传文件列表，右侧直接查看当前文件的摘要、状态和正文内容。
              </p>
              <div className="sidebar-action-stack">
                <label className="upload-button">
                  {knowledgeUploadProgress && knowledgeUploadProgress.stage !== 'failed' && knowledgeUploadProgress.stage !== 'complete'
                    ? '正在处理...'
                    : '上传文件'}
                  <input
                    id={knowledgeFileUploadInputId}
                    className="visually-hidden-file-input"
                    type="file"
                    accept=".docx,.doc,.rtf,.txt,.md,.markdown,.pdf,.wps"
                    multiple
                    onChange={(event) => void handleKnowledgeFileUpload(event)}
                  />
                </label>
                <button className="ghost-button" type="button" onClick={() => void handleLinkKnowledgeFolder()}>
                  上传文件夹
                </button>
              </div>
              {renderKnowledgeUploadProgressCard(true)}
              <input
                className="search-input"
                value={settingsKnowledgeFileKeyword}
                onChange={(event) => setSettingsKnowledgeFileKeyword(event.target.value)}
                placeholder="搜索上传文件"
              />
              <div className="knowledge-sidebar-file-list">
                {filteredSettingsKnowledgeFiles.length ? filteredSettingsKnowledgeFiles.map((entry) => (
                  <button
                    key={entry.id}
                    className={`knowledge-sidebar-file-item ${selectedSettingsKnowledgeFile?.id === entry.id ? 'active' : ''}`}
                    type="button"
                    onClick={() => setSettingsSelectedKnowledgeFileId(entry.id)}
                  >
                    <strong>{entry.title}</strong>
                    <span>{entry.fileName}</span>
                    <div className="knowledge-chip-row">
                      <span className="knowledge-chip">抽取：{getProcessingStatusLabel(entry.extractionStatus)}</span>
                      <span className="knowledge-chip">向量：{getProcessingStatusLabel(entry.vectorStatus)}</span>
                    </div>
                  </button>
                )) : (
                  <div className="empty-box">还没有上传知识文件。</div>
                )}
              </div>
            </>
          ) : null}
          {settingsTab === 'files' ? null : (
            null
          )}
        </div>

        <div className="panel pro-card sidebar-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">说明</span>
              <h2>模块用途</h2>
            </div>
          </div>
          <ul className="plain-list">
            <li>上传 Word、PDF、RTF、TXT、Markdown 等常见知识文件。</li>
            <li>查看知识文件列表、文本抽取状态与向量化状态。</li>
            <li>在右侧直接查看文件摘要、状态与正文预览。</li>
          </ul>
        </div>

        {showFooter ? renderSidebarFooter() : null}
      </aside>
    )
  }

  function renderKnowledgeUploadProgressCard(compact = false) {
    if (!knowledgeUploadProgress) {
      return null
    }

    const steps = getKnowledgeUploadSteps(knowledgeUploadProgress)

    return (
      <div className={`knowledge-upload-progress-card ${compact ? 'compact' : ''}`}>
        <div className="knowledge-upload-progress-head">
          <strong>处理进度</strong>
          <span className={`status-chip ${getKnowledgeUploadStageTone(knowledgeUploadProgress.stage)}`}>
            {getKnowledgeUploadStageLabel(knowledgeUploadProgress.stage)}
          </span>
        </div>
        <p>{knowledgeUploadProgress.message}</p>
        <div className="knowledge-upload-step-list">
          {steps.map((step) => (
            <div key={step.key} className={`knowledge-upload-step ${step.state}`}>
              <span />
              <strong>{step.label}</strong>
            </div>
          ))}
        </div>
        <div className="knowledge-upload-progress-meta">
          <span>
            {knowledgeUploadProgress.source === 'folder' ? '文件夹导入' : '文件上传'}
            {' · '}
            共 {knowledgeUploadProgress.total} 份
          </span>
          <span title={knowledgeUploadProgress.fileNames.join('、')}>
            {knowledgeUploadProgress.fileNames.slice(0, compact ? 2 : 3).join('、')}
            {knowledgeUploadProgress.fileNames.length > (compact ? 2 : 3) ? ` 等 ${knowledgeUploadProgress.fileNames.length} 份` : ''}
          </span>
        </div>
      </div>
    )
  }

  function renderKnowledgeReindexProgressCard(progress: KnowledgeReindexProgress) {
    const steps = getKnowledgeReindexSteps(progress)

    return (
      <div className="knowledge-upload-progress-card">
        <div className="knowledge-upload-progress-head">
          <strong>{progress.mode === 'vectorize' ? '重新向量化进度' : '重新处理进度'}</strong>
          <span className={`status-chip ${getKnowledgeReindexStageTone(progress.stage)}`}>
            {getKnowledgeReindexStageLabel(progress.stage)}
          </span>
        </div>
        <p>{progress.message}</p>
        <div className="knowledge-upload-step-list">
          {steps.map((step) => (
            <div key={step.key} className={`knowledge-upload-step ${step.state}`}>
              <span />
              <strong>{step.label}</strong>
            </div>
          ))}
        </div>
        <div className="knowledge-upload-progress-meta">
          <span>{progress.mode === 'vectorize' ? '向量索引刷新' : '原文件重新处理'}</span>
          <span title={progress.fileName}>{progress.fileName}</span>
        </div>
      </div>
    )
  }

  function renderSettingsCenter() {
    if (settingsTab === 'files') {
      const selectedKnowledgeReindexProgress = selectedSettingsKnowledgeFile
        ? knowledgeReindexProgressByFileId[selectedSettingsKnowledgeFile.id] ?? null
        : null

      return (
        <section
          ref={settingsKnowledgeFilesSectionRef}
          className="knowledge-file-workspace"
        >
          <input
            ref={knowledgeFolderUploadRef}
            className="hidden-file-input"
            type="file"
            multiple
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(event) => void handleKnowledgeFolderUpload(event)}
          />

          <article className="panel pro-card knowledge-file-preview-panel">
            {knowledgeUploadProgress ? renderKnowledgeUploadProgressCard() : null}
            {selectedSettingsKnowledgeFile ? (
              <>
                {selectedKnowledgeReindexProgress
                  ? renderKnowledgeReindexProgressCard(selectedKnowledgeReindexProgress)
                  : null}
                <div className="panel-header">
                  <div>
                    <span className="eyebrow">文件详情</span>
                    <h2>{selectedSettingsKnowledgeFile.title}</h2>
                  </div>
                  <div className="panel-header-actions">
                    <span className={`status-chip ${selectedSettingsKnowledgeFile.extractionStatus === 'ready' ? 'ready' : 'in_review'}`}>
                      {getProcessingStatusLabel(selectedSettingsKnowledgeFile.extractionStatus)}
                    </span>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => void handleReindexKnowledgeFile(selectedSettingsKnowledgeFile)}
                      disabled={
                        selectedKnowledgeReindexProgress !== null
                        && selectedKnowledgeReindexProgress.stage !== 'complete'
                        && selectedKnowledgeReindexProgress.stage !== 'failed'
                      }
                    >
                      {selectedKnowledgeReindexProgress !== null
                        && selectedKnowledgeReindexProgress.stage !== 'complete'
                        && selectedKnowledgeReindexProgress.stage !== 'failed'
                        ? (selectedKnowledgeReindexProgress.mode === 'vectorize' ? '正在向量化...' : '正在处理...')
                        : (selectedSettingsKnowledgeFile.extractedText.trim() ? '重新向量化' : '重新处理')}
                    </button>
                  </div>
                </div>

                <div className="knowledge-file-meta-grid">
                  <div>
                    <span>文件类型</span>
                    <strong>{getKnowledgeFileKindLabel(selectedSettingsKnowledgeFile.fileKind)}</strong>
                  </div>
                  <div>
                    <span>上传时间</span>
                    <strong>{formatDateTime(selectedSettingsKnowledgeFile.uploadedAt)}</strong>
                  </div>
                  <div>
                    <span>处理状态</span>
                    <strong>
                      抽取：{getProcessingStatusLabel(selectedSettingsKnowledgeFile.extractionStatus)}
                      {' / '}
                      向量：{getProcessingStatusLabel(selectedSettingsKnowledgeFile.vectorStatus)}
                    </strong>
                  </div>
                  <div>
                    <span>文件名</span>
                    <strong>{selectedSettingsKnowledgeFile.fileName}</strong>
                  </div>
                </div>

                {selectedSettingsKnowledgeFile.extractionError ? (
                  <div className="knowledge-detail-block knowledge-warning-block">
                    <strong>抽取提示</strong>
                    <p>{selectedSettingsKnowledgeFile.extractionError}</p>
                  </div>
                ) : null}

                {selectedSettingsKnowledgeFile.vectorError ? (
                  <div className="knowledge-detail-block knowledge-warning-block">
                    <strong>向量提示</strong>
                    <p>{selectedSettingsKnowledgeFile.vectorError}</p>
                  </div>
                ) : null}

                <div className="knowledge-file-preview-split">
                  <div className="knowledge-detail-block">
                    <strong>知识摘要</strong>
                    <p>{selectedSettingsKnowledgeFile.summary || '暂未生成摘要。'}</p>
                    <div className="knowledge-chip-row">
                      {selectedSettingsKnowledgeFile.vectorKeywords.length
                        ? selectedSettingsKnowledgeFile.vectorKeywords.map((item) => (
                            <span className="knowledge-chip" key={item}>{item}</span>
                          ))
                        : <span className="knowledge-chip">暂未生成关键词</span>}
                    </div>
                  </div>

                  <div className="knowledge-detail-block knowledge-file-preview-block">
                    <strong>文件预览</strong>
                    <p className="knowledge-text-preview knowledge-text-preview-expanded">
                      {selectedSettingsKnowledgeFile.extractedText || '点击左侧文件列表后，这里会显示对应文件的正文预览。当前文件已入库，但暂未抽取出可预览的正文内容。'}
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-box">请先在左侧上传或选择一个知识文件，右侧会显示对应文件的详情与预览。</div>
            )}
          </article>
        </section>
      )
    }

    return (
      <section
        ref={settingsStatutesSectionRef}
        className="knowledge-layout knowledge-layout-cleared"
        aria-label="内置法条内容区"
      />
    )
  }

  function renderCaseCenterSidebar() {
    if (streamlinedMode) {
      return (
        <aside className={`sidebar streamlined-sidebar ${isStreamlinedSidebarCollapsed ? 'is-collapsed' : ''}`}
          tabIndex={-1} aria-label="证据目录">
          <div className="streamlined-sidebar-toggle-row">
            {isStreamlinedSidebarCollapsed ? null : (
              <span className="eyebrow streamlined-sidebar-toggle-label">证据目录</span>
            )}
            <button
              className="ghost-button streamlined-sidebar-toggle-button"
              type="button"
              onClick={handleToggleStreamlinedSidebar}
              aria-expanded={!isStreamlinedSidebarCollapsed}
              aria-label={isStreamlinedSidebarCollapsed ? '展开证据目录' : '收起证据目录'}
              title={isStreamlinedSidebarCollapsed ? '展开证据目录' : '收起证据目录'}
            >
              <SidebarToggleIcon collapsed={isStreamlinedSidebarCollapsed} />
              <span>{isStreamlinedSidebarCollapsed ? '展开' : '收起目录'}</span>
            </button>
          </div>

          {isStreamlinedSidebarCollapsed ? null : (
            <>
              <div className="panel pro-card sidebar-panel streamlined-evidence-panel streamlined-evidence-merged-panel">
                <div className="streamlined-evidence-topbar">
                  <div className="streamlined-case-heading">
                    <span className="eyebrow streamlined-case-heading-eyebrow">当前案件</span>
                    <h2 title={selectedCase?.name ?? '未选择案件'}>
                      {selectedCase?.name ?? '未选择案件'}
                    </h2>
                  </div>
                  <span className={`status-chip ${selectedCase?.status ?? 'ready'} streamlined-case-count`}>
                    {displayCaseEvidences.length} 份
                  </span>
                </div>
                <div className="case-selector-row streamlined-case-selector-row">
                  <select
                    className="streamlined-case-select"
                    aria-label="选择案件"
                    disabled={!appState?.cases.length}
                    value={selectedCaseId ?? ''}
                    onChange={(event) => {
                      const caseId = event.target.value
                      if (caseId) {
                        handleSelectCase(caseId)
                      }
                    }}
                  >
                    {!appState?.cases.length ? <option value="">请先新建案件</option> : null}
                    {appState?.cases.map((caseFolder) => (
                      <option key={caseFolder.id} value={caseFolder.id}>
                        {caseFolder.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="ghost-button case-action-icon-button"
                    type="button"
                    onClick={() => selectedCase && handleOpenRenameCaseDialog(selectedCase)}
                    disabled={!selectedCase || isSubmitting}
                    title={selectedCase ? `重命名：${selectedCase.name}` : '请先选择案件'}
                    aria-label={selectedCase ? `重命名：${selectedCase.name}` : '请先选择案件'}
                  >
                    <span aria-hidden="true">✎</span>
                  </button>
                  <button
                    className="ghost-button case-action-icon-button"
                    type="button"
                    onClick={handleOpenCreateCaseDialog}
                    disabled={isSubmitting}
                    title="新建案件"
                    aria-label="新建案件"
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                </div>
                <input
                  ref={folderUploadRef}
                  className="hidden-file-input"
                  type="file"
                  multiple
                  {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                  onChange={(event) => void handleUpload(event)}
                />
                <div className="streamlined-evidence-toolbar">
                  <span className="streamlined-evidence-summary" title={linkedFolderSummary}>
                    {linkedFolderSummary}
                  </span>
                  <div className="folder-link-trigger">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => void handleLinkFolder()}
                      disabled={!selectedCase || isSubmitting || Boolean(evidenceImportProgress)}
                    >
                      {evidenceImportProgress ? '正在链接...' : '链接文件夹'}
                    </button>
                    {renderFolderLinkGuidePopup()}
                  </div>
                  <button className="ghost-button" type="button"
                    onClick={() => void handleClearFolderLinks()}
                    disabled={!selectedCase || isSubmitting || Boolean(evidenceImportProgress) || Boolean(directoryPreparation)}>
                    清除链接
                  </button>
                </div>
                {!selectedCase && shouldShowEmptyCaseOnboarding ? (
                  <div className="entry-onboarding-inline-card">
                    <strong>先新建案件，再开始整理材料</strong>
                    <p>登录后的第一步先建立案件，后续导入的本地文件夹、质证书版本和核验记录都会归到这个案件里。</p>
                    <button className="primary-button" type="button" onClick={handleOpenCreateCaseDialog} disabled={isSubmitting}>
                      新建案件
                    </button>
                  </div>
                ) : null}
                {evidenceImportProgress ? (
                  <div className="evidence-progress-card" role="status" aria-live="polite">
                    <div className="evidence-progress-head">
                      <strong className="evidence-progress-title">
                        <span className="linkage-progress-spinner" aria-hidden="true" />
                        正在链接资料
                      </strong>
                      <span>
                        {evidenceImportProgress.total > 0
                          ? `${Math.min(
                              100,
                              Math.round((evidenceImportProgress.completed / evidenceImportProgress.total) * 100),
                            )}%`
                          : '进行中'}
                      </span>
                    </div>
                    <div className={`evidence-progress-bar ${evidenceImportProgress.total > 0 ? '' : 'indeterminate'}`}>
                      <span
                        style={{
                          width: evidenceImportProgress.total > 0
                            ? `${Math.min(
                                100,
                                Math.round((evidenceImportProgress.completed / evidenceImportProgress.total) * 100),
                              )}%`
                            : '42%',
                        }}
                      />
                    </div>
                    <p className="evidence-progress-copy">{evidenceImportProgress.message}</p>
                  </div>
                ) : null}
                {evidenceImportResult && evidenceImportResult.caseId === selectedCase?.id ? (
                  <div className="evidence-import-result" role="status" aria-live="polite">
                    <span>{evidenceImportResult.message}</span>
                    <button className="ghost-button" type="button" onClick={() => setEvidenceImportResult(null)} aria-label="关闭链接完成提示">
                      关闭
                    </button>
                  </div>
                ) : null}
                {directoryImportRetry?.caseId === selectedCase?.id && directoryImportRetry ? (
                  <div className="evidence-progress-card" role="alert">
                    <p className="evidence-progress-copy">{directoryImportRetry.message}</p>
                    <button className="ghost-button" type="button" disabled={isSubmitting}
                      onClick={() => void handleLinkFolder(directoryImportRetry.directory)}>重试接入</button>
                  </div>
                ) : null}
                {!evidenceImportProgress && directoryPreparation?.caseId === selectedCase?.id && directoryPreparation ? (
                  <div className="evidence-progress-card" role="status" aria-live="polite">
                    <div className="evidence-progress-head">
                      <strong className="evidence-progress-title">
                        <span className="linkage-progress-spinner" aria-hidden="true" />
                        正在准备理解
                      </strong>
                      <span>{directoryPreparation.completed}/{directoryPreparation.total}</span>
                    </div>
                    <div className="evidence-progress-bar" role="progressbar" aria-label="理解准备进度"
                      aria-valuemin={0} aria-valuemax={directoryPreparation.total || 1} aria-valuenow={directoryPreparation.completed}>
                      <span style={{ width: directoryPreparation.total
                        ? `${Math.round(directoryPreparation.completed / directoryPreparation.total * 100)}%` : '100%' }} />
                    </div>
                    <p className="evidence-progress-copy">可随时预览原件</p>
                  </div>
                ) : !evidenceImportProgress && understandingActive ? (
                  <div className="evidence-progress-card" role="status" aria-live="polite">
                    <div className="evidence-progress-head">
                      <strong className="evidence-progress-title">
                        <span className="linkage-progress-spinner" aria-hidden="true" />
                        正在整理理解
                      </strong>
                      <span>{understoodCount}/{understandingEvidences.length}</span>
                    </div>
                    <div className={`evidence-progress-bar ${understandingEvidences.length ? '' : 'indeterminate'}`}
                      role="progressbar" aria-label="材料理解进度" aria-valuemin={0}
                      aria-valuemax={understandingEvidences.length || 100}
                      aria-valuenow={understandingEvidences.length ? understoodCount : undefined}>
                      <span style={{ width: understandingEvidences.length
                        ? `${Math.round(understoodCount / understandingEvidences.length * 100)}%` : '42%' }} />
                    </div>
                    <p className="evidence-progress-copy">{understandingEvidences.length && understoodCount < understandingEvidences.length
                      ? '可随时预览原件' : '正在梳理案件要点'}</p>
                  </div>
                ) : !evidenceImportProgress && understandingTask?.status === 'ready' ? (
                  <div className="evidence-import-result" role="status">整理理解完成</div>
                ) : !evidenceImportProgress && understandingTask?.status === 'failed' ? (
                  <div className="evidence-progress-card" role="alert">
                    <p className="evidence-progress-copy">理解暂未完成，原件可正常预览。</p>
                    <p className="evidence-progress-copy">{understandingTask.error}</p>
                    <button className="ghost-button" type="button" disabled={isSubmitting}
                      onClick={() => void runMutation(async () => {
                        const { workspace } = await api.retryCaseAgent(selectedCase!.id)
                        applyWorkspace(workspace, { selectedCaseId }, { preserveManualPreview: true })
                      })}>重试理解</button>
                  </div>
                ) : null}
                <div className="streamlined-evidence-list">
                  {displayCaseEvidences.length ? (
                    <VirtualList items={evidenceTreeRows} itemKey={evidenceRowKey}
                      estimateHeight={evidenceRowHeight} renderItem={renderEvidenceTreeRow}
                      focusKey={manualPreviewEvidenceId} />
                  ) : (
                    <div className="empty-box compact-empty">
                      {selectedCase
                        ? '请先链接本地文件夹。'
                        : '请先新建案件。'}
                    </div>
                  )}
                </div>
              </div>

            </>
          )}
        </aside>
      )
    }

    return (
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="eyebrow">LawVerify</span>
          <h2>案件中心</h2>
          <p>围绕单个案件完成材料整理、起草、核验与定稿。</p>
        </div>

        <button className="primary-button wide-button" type="button" onClick={handleOpenCreateCaseDialog} disabled={isSubmitting}>
          新建案件
        </button>

        <input
          className="search-input"
          value={caseSearch}
          onChange={(event) => setCaseSearch(event.target.value)}
          placeholder="搜索案件名称"
        />

        <div className="case-list">
          {filteredCases.map((caseFolder) => (
            <button
              key={caseFolder.id}
              className={`case-item ${caseFolder.id === selectedCaseId ? 'active' : ''}`}
              type="button"
              onClick={() => handleSelectCase(caseFolder.id)}
            >
              <div className="case-item-top">
                <strong>{caseFolder.name}</strong>
                <span className={`status-chip ${caseFolder.status}`}>{getStatusLabel(caseFolder.status)}</span>
              </div>
              <span>{formatDateTime(caseFolder.createdAt)}</span>
              <div className="inline-actions">
                <span>
                  {appState!.evidences.filter((item) => item.caseId === caseFolder.id).length} 份证据
                </span>
                <div>
                  <span
                    className="text-link"
                    onClick={(event) => {
                      event.stopPropagation()
                      handleOpenRenameCaseDialog(caseFolder)
                    }}
                  >
                    重命名
                  </span>
                  <span
                    className="text-link danger"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleDeleteCase(caseFolder)
                    }}
                  >
                    删除
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>

        {renderSidebarFooter()}
      </aside>
    )
  }

  function renderCaseCenterOverview() {
    if (!selectedCase) {
      return (
        <section className="grid-two">
          <article className="panel pro-card case-entry-onboarding-card">
            <div className="panel-header">
              <div>
                <span className="eyebrow">首次进入</span>
                <h2>先新建案件，再链接本地材料</h2>
              </div>
            </div>
            <p className="case-entry-onboarding-copy">
              登录后的第一步建议先建立案件。后续导入的证据目录、生成的质证书版本和核验记录，都会绑定到当前案件下。
            </p>
            <div className="case-entry-onboarding-actions">
              <button className="primary-button" type="button" onClick={handleOpenCreateCaseDialog} disabled={isSubmitting}>
                新建案件
              </button>
            </div>
            <div className="architecture-summary case-entry-onboarding-steps">
              <article>
                <strong>1. 新建案件</strong>
                <p>先创建一个清晰的案件名称，例如“王某买卖合同纠纷”。</p>
              </article>
              <article>
                <strong>2. 链接本地文件夹</strong>
                <p>选择电脑里的案件材料目录，系统会按目录结构导入证据。</p>
              </article>
              <article>
                <strong>3. 进入办案流转</strong>
                <p>完成导入后即可继续整理证据、起草质证书与核验定稿。</p>
              </article>
            </div>
          </article>
        </section>
      )
    }

    return (
      <>
        <section className="stats-grid">
          <article className="stat-card">
            <span>当前案件证据</span>
            <strong>{caseEvidences.length}</strong>
          </article>
          <article className="stat-card">
            <span>质证书版本</span>
            <strong>{caseCertificates.length}</strong>
          </article>
          <article className="stat-card">
            <span>已核验段落</span>
            <strong>{verifiedParagraphCount}</strong>
          </article>
          <article className="stat-card">
            <span>法律与案例引用</span>
            <strong>{activeParagraphReferences.length}</strong>
          </article>
        </section>

        <section className="grid-two">
          <article className="panel pro-card">
            <div className="panel-header">
              <div>
                <span className="eyebrow">案件概览</span>
                <h2>{selectedCase?.name ?? '请先创建案件'}</h2>
              </div>
              <div className="panel-header-actions">
                {selectedCase ? <span className={`status-chip ${selectedCase.status}`}>{getStatusLabel(selectedCase.status)}</span> : null}
                {selectedCase ? (
                  selectedCase.status === 'ready' ? (
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => void handleUpdateCaseStatus('in_review')}
                    >
                      恢复为核验中
                    </button>
                  ) : (
                    <button
                      className="primary-button"
                      type="button"
                      disabled={!canMarkCaseReady}
                      onClick={() => void handleUpdateCaseStatus('ready')}
                    >
                      标记案件为已核验
                    </button>
                  )
                ) : null}
              </div>
            </div>
            <textarea
              className="description-box"
              value={selectedCase?.description ?? ''}
              onChange={(event) => {
                void handleUpdateCaseDescription(event.target.value)
              }}
              placeholder="填写案件背景、争议焦点、庭审目标"
            />
            {selectedCase?.status !== 'ready' ? (
              <p className="panel-hint">
                {canMarkCaseReady
                  ? '当前质证书各段已完成核验，可以将案件状态更新为已核验。'
                  : '请先在核验定稿中完成当前质证书全部段落核验，再将案件状态标记为已核验。'}
              </p>
            ) : (
              <p className="panel-hint success">当前案件已进入已核验状态。</p>
            )}
          </article>

          <article className="panel pro-card">
            <div className="panel-header">
              <div>
                <span className="eyebrow">案件流程</span>
                <h2>下一步动作</h2>
              </div>
            </div>
            <div className="architecture-summary">
              <article>
                <strong>证据整理</strong>
                <p>{caseEvidences.length} 份材料已进入案件库，可继续导入、改名与清洗摘要。</p>
              </article>
              <article>
                <strong>起草进展</strong>
                <p>{caseCertificates.length} 个质证书版本，可继续基于已选证据生成新版本。</p>
              </article>
              <article>
                <strong>核验状态</strong>
                <p>{verifiedParagraphCount} 段已人工核验，{unlinkedParagraphCount} 段仍待补齐锚点。</p>
              </article>
            </div>
            <div className="tab-row sidebar-action-row">
              <button type="button" onClick={() => openCaseCenter('evidence')}>整理证据</button>
              <button type="button" onClick={() => openCaseCenter('draft')}>进入起草</button>
              <button type="button" onClick={() => openCaseCenter('review')}>进入核验</button>
            </div>
          </article>
        </section>

        <section className="grid-two">
          <article className="panel pro-card">
            <div className="panel-header">
              <div>
                <span className="eyebrow">版本管理</span>
                <h2>当前案件质证书</h2>
              </div>
            </div>
            {renderCertificateVersionList('draft')}
          </article>

          <article className="panel pro-card">
            <div className="panel-header">
              <div>
                <span className="eyebrow">知识支撑</span>
                <h2>当前引用情况</h2>
              </div>
            </div>
            <ul className="plain-list">
              <li>法院案例库：{appState!.knowledgeCases.length} 条可供检索与绑定</li>
              <li>法律条文库：{appState!.knowledgeStatutes.length} 部法律文件</li>
              <li>当前段落已绑定：法条 {activeStatuteReferences.length} 条，案例 {activeCaseReferences.length} 条</li>
              <li>进入知识库可继续检索全文，再回到核验定稿绑定引用</li>
            </ul>
          </article>
        </section>
      </>
    )
  }

  function renderCaseCenterEvidence() {
    return (
      <section className="grid-two">
        <article className="panel pro-card">
          <div className="panel-header">
            <div>
              <span className="eyebrow">证据材料</span>
              <h2>{selectedCase?.name ?? '请先创建案件'}</h2>
            </div>
            <div className="upload-actions">
              <label className="upload-button">
                导入文件
                <input type="file" multiple onChange={(event) => void handleUpload(event)} />
              </label>
              <label className="upload-button">
                导入文件夹
                <input
                  type="file"
                  multiple
                  {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                  onChange={(event) => void handleUpload(event)}
                />
              </label>
            </div>
          </div>
          <div className="upload-hint">
            导入时会按目录路径稳定生成证据编号，并自动整理为规范名称；原始文件名与原始目录会保留用于追溯。
          </div>

          <div className="evidence-list">
            {groupedCaseEvidences.map((group) => (
              <section className="evidence-group" key={group.key || 'root'}>
                <div className="evidence-group-title">{group.label}</div>
                {group.evidences.map((evidence) => (
                  <article className="evidence-card" key={evidence.id}>
                    <div className="evidence-head">
                      <label className="checkbox-row">
                        <input
                          checked={selectedEvidenceIds.includes(evidence.id)}
                          type="checkbox"
                          onChange={() => toggleEvidenceSelection(evidence.id)}
                        />
                        <span>{evidence.number}</span>
                      </label>
                      <span className="type-badge">{evidence.type.toUpperCase()}</span>
                    </div>

                    <div className="evidence-path">{getEvidenceDirectoryParts(evidence).relativePath}</div>

                    <input
                      className="title-input"
                      value={evidence.name}
                      onChange={(event) => {
                        void handleUpdateEvidence(evidence.id, { name: event.target.value })
                      }}
                    />

                    <textarea
                      value={evidence.ocrText}
                      onChange={(event) => {
                        void handleUpdateEvidence(evidence.id, { ocrText: event.target.value })
                      }}
                    />

                    <div className="card-footer">
                      <span>{formatDateTime(evidence.uploadedAt)}</span>
                      <span className="text-link danger" onClick={() => void handleDeleteEvidence(evidence.id)}>
                        删除
                      </span>
                    </div>
                  </article>
                ))}
              </section>
            ))}

            {!caseEvidences.length ? (
              <div className="empty-box">暂无证据材料</div>
            ) : null}
          </div>
        </article>

        <article className="panel pro-card">
          <div className="panel-header">
            <div>
              <span className="eyebrow">材料使用</span>
              <h2>起草准备</h2>
            </div>
          </div>
          <div className="sidebar-stat-grid">
            <article>
              <span>已选证据</span>
              <strong>{selectedEvidenceIds.length}</strong>
            </article>
            <article>
              <span>目录层级</span>
              <strong>{evidenceFolderCount}</strong>
            </article>
          </div>
          <ul className="plain-list">
            <li>先勾选拟纳入本版质证书的证据材料，再进入质证书起草。</li>
            <li>证据名称与 OCR 摘要可在此直接修订，减少后续起草偏差。</li>
            <li>文件夹导入会保留原始目录结构，方便按案卷组织管理。</li>
          </ul>
          <div className="tab-row sidebar-action-row">
            <button className="primary-button" type="button" onClick={() => openCaseCenter('draft')}>
              进入质证书起草
            </button>
            <button type="button" onClick={() => openCaseCenter('review')}>
              进入核验定稿
            </button>
          </div>
          {selectedEvidenceIds.length ? (
            <div className="knowledge-reference-list">
              {caseEvidences
                .filter((item) => selectedEvidenceIds.includes(item.id))
                .map((evidence) => (
                  <article className="knowledge-reference-card" key={evidence.id}>
                    <div>
                      <strong>{evidence.number} {evidence.name}</strong>
                      <span>{getEvidenceDirectoryParts(evidence).folderLabel}</span>
                    </div>
                    <p>{evidence.ocrText.slice(0, 120)}{evidence.ocrText.length > 120 ? '...' : ''}</p>
                  </article>
                ))}
            </div>
          ) : (
            <div className="empty-box">当前尚未勾选本版起草证据。</div>
          )}
        </article>
      </section>
    )
  }

  function renderCaseCenterDraft() {
    return (
      <section className="grid-two">
        <article className="panel pro-card">
          <div className="panel-header">
            <div>
              <span className="eyebrow">质证书起草</span>
              <h2>生成与版本管理</h2>
            </div>
          </div>
          <div className="sidebar-stat-grid">
            <article>
              <span>已选证据</span>
              <strong>{selectedEvidenceIds.length}</strong>
            </article>
            <article>
              <span>已有版本</span>
              <strong>{caseCertificates.length}</strong>
            </article>
          </div>
          <ul className="plain-list">
            <li>起草阶段以当前勾选证据为基础生成新版本。</li>
            <li>生成后可继续追问改写当前草稿，再进入核验定稿逐段校核。</li>
            <li>若需要补充材料，请先回到证据材料页继续整理。</li>
          </ul>
          <div className="tab-row sidebar-action-row">
            <button type="button" onClick={() => openCaseCenter('evidence')}>返回证据材料</button>
            <button type="button" onClick={() => openCaseCenter('review')}>进入核验定稿</button>
          </div>
          {renderCertificateVersionList('draft')}
        </article>

        <article className="panel pro-card">
          <div className="panel-header">
            <div>
              <span className="eyebrow">当前文稿</span>
              <h2>{activeCertificate?.title ?? '请先生成质证书'}</h2>
            </div>
          </div>
          {renderCertificateEditor()}
        </article>
      </section>
    )
  }

  function renderCaseCenterReview() {
    if (streamlinedMode) {
      return (
        <>
          <section
            className={`streamlined-workbench ide-workbench ${isResizingWorkbench ? 'is-resizing' : ''}`}
            ref={workbenchRef}
            style={{ '--streamlined-insight-width': `${insightPanelWidth}px` } as CSSProperties}
          >
            <article className="panel pro-card streamlined-document-panel">
              <div className="ide-editor-tabs" role="group" aria-label="主浏览区">
                <button type="button" className={ideContentTab === 'document' ? 'active' : ''}
                  aria-pressed={ideContentTab === 'document'} onClick={() => setIdeContentTab('document')}>
                  文书{activeCertificate ? ` · ${activeCertificate.title}` : ''}
                </button>
                {previewEvidence ? <button type="button" className={ideContentTab === 'evidence' ? 'active' : ''}
                  aria-pressed={ideContentTab === 'evidence'} onClick={() => setIdeContentTab('evidence')}
                  title={previewEvidence.fileName}>
                  {previewEvidence.fileName}
                </button> : null}
              </div>
              {ideContentTab === 'evidence' && previewEvidence ? renderEvidencePreview('source') : null}
              <div className="ide-document-view" tabIndex={-1} aria-label="文书工作区"
                hidden={ideContentTab === 'evidence' && Boolean(previewEvidence)}>
              <div className="panel-header">
                <div className="panel-header-title-group">
                  <div>
                    <span className="eyebrow">AI 文书</span>
                    {activeCertificate?.title ? <h2>{activeCertificate.title}</h2> : null}
                  </div>
                  {selectedCase && activeCertificate ? <span className={`status-chip ${selectedCase.status}`}>{getStatusLabel(selectedCase.status)}</span> : null}
                </div>
                <div className="panel-header-actions">
                  <input
                    id={certificateUploadInputId}
                    ref={certificateUploadRef}
                    className="visually-hidden-file-input"
                    type="file"
                    accept=".docx,.doc,.rtf,.txt,.md,.wps"
                    onChange={(event) => void handleCertificateUploadInput(event)}
                  />
                  <label
                    className={`header-action-button ${!selectedCase || isSubmitting ? 'disabled' : ''}`}
                    htmlFor={!selectedCase || isSubmitting ? undefined : certificateUploadInputId}
                    title="上传文书"
                  >
                    <span className="icon">↑</span> 上传文书
                  </label>

                  <button
                    className="header-action-button primary"
                    type="button"
                    onClick={() => activeCertificate && void exportCertificateToWord(activeCertificate, selectedCase?.name ?? '')}
                    disabled={!activeCertificate}
                    title="下载为 Word 文档"
                  >
                    <span className="icon">↓</span> 下载文书
                  </button>
                </div>
              </div>
              {renderCertificateEditor()}
              </div>
            </article>

            <div
              aria-label="调整文书与原文核验区域宽度"
              aria-orientation="vertical"
              className="streamlined-workbench-resizer"
              onDoubleClick={() => setInsightPanelWidth(DEFAULT_INSIGHT_PANEL_WIDTH)}
              onPointerDown={handleStartWorkbenchResize}
              role="separator"
              tabIndex={0}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const maxWidth = Math.max(MIN_INSIGHT_PANEL_WIDTH,
                  (workbenchRef.current?.clientWidth ?? 0) - MIN_DOCUMENT_PANEL_WIDTH - WORKBENCH_RESIZER_WIDTH)
                setInsightPanelWidth(width => Math.min(maxWidth, Math.max(MIN_INSIGHT_PANEL_WIDTH,
                  width + (event.key === 'ArrowLeft' ? 20 : -20))))
              }}
              title="拖动调整主浏览区与详情栏宽度"
            />

            <aside className="panel pro-card streamlined-insight-panel">
              <div className="ide-insight-tabs" role="group" aria-label="交互与详情栏">
                <button className={isIdeAssistantVisible ? 'active' : ''} type="button"
                  aria-pressed={isIdeAssistantVisible} onClick={() => setIsIdeAssistantVisible(true)}>助手</button>
                  {[
                    ['evidence', '材料'],
                    ['statute', '法条'],
                    ['case', '案例'],
                    ['memory', '记忆'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      className={!isIdeAssistantVisible && verifyInsightTab === key ? 'active' : ''}
                      aria-pressed={!isIdeAssistantVisible && verifyInsightTab === key}
                      type="button"
                      onClick={() => { setVerifyInsightTab(key as VerifyInsightTab); setIsIdeAssistantVisible(false) }}
                    >
                      {label}
                    </button>
                  ))}
              </div>

              <div className={`streamlined-insight-content ${isIdeAssistantVisible ? 'ide-assistant-content' : ''}`} ref={evidenceColumnRef}>
                <div className="ide-assistant-view" tabIndex={-1} aria-label="案件助手" hidden={!isIdeAssistantVisible}>
                  {renderAgentDock(true)}
                </div>
                {isIdeAssistantVisible ? null : verifyInsightTab === 'evidence' && ideContentTab === 'evidence'
                  ? renderEvidencePreview('details') : renderVerifyInsightPanel()}
              </div>
            </aside>
          </section>
        </>
      )
    }

    return (
      <section className="panel verify-panel pro-card">
        <div className="panel-header">
          <div>
            <span className="eyebrow">核验定稿</span>
            <h2>{activeCertificate?.title ?? '请先生成质证书'}</h2>
          </div>
          <div className="tab-row knowledge-tab-row">
            {[
              ['evidence', '证据原件'],
              ['statute', '法律依据'],
              ['case', '案例参照'],
              ['memory', '案件记忆'],
            ].map(([key, label]) => (
              <button
                key={key}
                className={verifyInsightTab === key ? 'active' : ''}
                type="button"
                onClick={() => setVerifyInsightTab(key as VerifyInsightTab)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="verify-grid">
          <div className="document-column">
            {renderCertificateEditor()}
          </div>

          <div className="evidence-column" ref={evidenceColumnRef}>
            {renderVerifyInsightPanel()}

            <div className="binder-panel">
              <label className="field-block">
                定位信息
                <input
                  value={locatorDraft}
                  onChange={(event) => {
                    const locator = event.target.value
                    setLocatorDraft(locator)
                    void handleUpdateActiveReference({ locator })
                  }}
                  placeholder="如：第 3 页 / 图片签名区域 / 段落 2"
                />
              </label>

              <label className="field-block">
                核验批注
                <textarea
                  value={activeParagraph?.note ?? ''}
                  onChange={(event) => {
                    void handleUpdateParagraph({ note: event.target.value })
                  }}
                  placeholder="记录修改理由、待补证点或庭审提醒"
                />
              </label>

              <div className="note-box">
                <div className="note-box-head">
                  <strong>当前段落支撑</strong>
                  <span className={`status-chip ${activeParagraph?.verified ? 'ready' : 'draft'}`}>
                    {activeParagraph?.verified ? '已核验' : '待复核'}
                  </span>
                </div>
                <span>
                  {activeEvidence
                    ? `${activeEvidence.number} ${activeEvidence.name}${activeParagraphLinks.length > 1 ? `（第 ${activeReferenceIndex + 1} 条）` : ''}`
                    : '当前段落尚未建立证据来源'}
                </span>
                <span>
                  法条 {activeStatuteReferences.length} 条，案例 {activeCaseReferences.length} 条
                </span>
              </div>

            </div>
          </div>
        </div>
      </section>
    )
  }

  function renderCaseCenterContent() {
    if (streamlinedMode) {
      return renderCaseCenterReview()
    }

    if (caseCenterTab === 'overview') {
      return renderCaseCenterOverview()
    }

    if (caseCenterTab === 'evidence') {
      return renderCaseCenterEvidence()
    }

    if (caseCenterTab === 'draft') {
      return renderCaseCenterDraft()
    }

    return renderCaseCenterReview()
  }

  if (!authToken) {
    return (
      <div className="login-shell">
        <section className="login-stage">
          <div className="brand-block">
            <div className="hero-topline">
              <span className="eyebrow">LawVerify</span>
              <span className="hero-label">For Litigation Professionals</span>
            </div>

            <div className="hero-simple">
              <div className="hero-copy-block">
                <h1>律师证据质证助手</h1>
                <p className="hero-slogan">再也不用为核对证据、案例、法条而耗时烦恼了</p>
                <p className="hero-copy">
                  为诉讼律师提供更安静、更专注的工作界面，把质证成稿、证据源定位和逐句核验整理在同一处完成。
                </p>

                <div className="hero-summary">
                  <div>
                    <strong>成品质证书</strong>
                    <span>接近 Word 的阅读与修订体验</span>
                  </div>
                  <div>
                    <strong>证据源联动</strong>
                    <span>点击句子，右侧即时显示原始证据</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="login-card pro-card">
            <div className="login-title">
              <span className="eyebrow">统一账户</span>
              <h2>{authMode === 'login' ? '登录平台' : '注册平台账号'}</h2>
            </div>

            <div className="tab-row login-mode-switch">
              <button
                className={authMode === 'login' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setAuthMode('login')
                  setIsSubmitting(false)
                  setErrorMessage('')
                }}
              >
                登录
              </button>
              <button
                className={authMode === 'register' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setAuthMode('register')
                  setIsSubmitting(false)
                  setErrorMessage('')
                }}
              >
                注册
              </button>
            </div>

            {authMode === 'login' ? (
              <>
                <label>
                  注册邮箱
                  <input
                    autoFocus
                    ref={loginEmailInputRef}
                    value={loginForm.account}
                    onChange={(event) =>
                      setLoginForm((current) => ({ ...current, account: event.target.value }))
                    }
                    placeholder="请输入平台官网注册邮箱"
                  />
                </label>

                <label>
                  登录密码
                  <div className="password-input-shell">
                    <input
                      type={isLoginPasswordVisible ? 'text' : 'password'}
                      value={loginForm.password}
                      onChange={(event) =>
                        setLoginForm((current) => ({ ...current, password: event.target.value }))
                      }
                      placeholder="请输入账号中心密码"
                    />
                    <button
                      className="password-visibility-button"
                      type="button"
                      onClick={() => setIsLoginPasswordVisible((current) => !current)}
                      aria-label={isLoginPasswordVisible ? '隐藏密码' : '显示密码'}
                    >
                      <PasswordVisibilityIcon visible={isLoginPasswordVisible} />
                    </button>
                  </div>
                </label>

                <button className="primary-button wide-button" type="button" onClick={handleLogin} disabled={isSubmitting}>
                  {isSubmitting ? '登录中...' : '进入系统'}
                </button>
              </>
            ) : (
              <>
                <label>
                  机构名称
                  <input
                    autoFocus
                    ref={registerOrganizationInputRef}
                    value={registerForm.organizationName}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, organizationName: event.target.value }))
                    }
                    placeholder="请输入律所或团队名称"
                  />
                </label>

                <label>
                  负责人姓名
                  <input
                    value={registerForm.ownerName}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, ownerName: event.target.value }))
                    }
                    placeholder="请输入负责人姓名"
                  />
                </label>

                <label>
                  注册邮箱
                  <input
                    value={registerForm.email}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, email: event.target.value }))
                    }
                    placeholder="请输入注册邮箱"
                  />
                </label>

                <label>
                  登录密码
                  <div className="password-input-shell">
                    <input
                      type={isRegisterPasswordVisible ? 'text' : 'password'}
                      value={registerForm.password}
                      onChange={(event) =>
                        setRegisterForm((current) => ({ ...current, password: event.target.value }))
                      }
                      placeholder="请设置账号中心密码"
                    />
                    <button
                      className="password-visibility-button"
                      type="button"
                      onClick={() => setIsRegisterPasswordVisible((current) => !current)}
                      aria-label={isRegisterPasswordVisible ? '隐藏密码' : '显示密码'}
                    >
                      <PasswordVisibilityIcon visible={isRegisterPasswordVisible} />
                    </button>
                  </div>
                </label>

                <label>
                  邀请码（选填）
                  <input value={registerForm.inviteCode ?? ''} maxLength={16}
                    onChange={event => setRegisterForm(current => ({ ...current, inviteCode: event.target.value }))} />
                </label>
                <button className="primary-button wide-button" type="button" onClick={handleRegister} disabled={isSubmitting}>
                  {isSubmitting ? '注册中...' : '注册并进入系统'}
                </button>
              </>
            )}

            <div className="inline-actions login-card-actions">
              <div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => void openExternalUrl(getAccountCenterRegisterUrl())}
                >
                  前往官网注册
                </button>
              </div>
            </div>

            {errorMessage ? <div className="inline-error">{errorMessage}</div> : null}

            {renderAppUpdateCard()}

            <div className="login-card-version" aria-label={`桌面端版本 v${__APP_VERSION__}`}>
              桌面端 v{__APP_VERSION__}
            </div>
          </div>
        </section>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="loading-shell">
        <div className="loading-card">
          <span className="eyebrow">LawVerify</span>
          <h2>正在加载案件工作区...</h2>
        </div>
      </div>
    )
  }

  if (!appState) {
    return (
      <div className="loading-shell">
        <div className="loading-card">
          <span className="eyebrow">LawVerify</span>
          <h2>案件工作区加载失败</h2>
          <p>{errorMessage || '当前未能获取工作区数据，请刷新页面后重试。'}</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    )
  }

  if (streamlinedMode) {
    const streamlinedShellStyle = {
      '--streamlined-sidebar-width': `${isStreamlinedSidebarCollapsed ? COLLAPSED_STREAMLINED_SIDEBAR_WIDTH : streamlinedSidebarWidth}px`,
      '--streamlined-shell-resizer-width': `${STREAMLINED_SIDEBAR_RESIZER_WIDTH}px`,
    } as CSSProperties

    return (
      <div
        ref={streamlinedShellRef}
        className={`app-shell pro-shell streamlined-shell ide-shell ${isStreamlinedSidebarCollapsed ? 'streamlined-shell-sidebar-collapsed' : ''} ${isResizingStreamlinedSidebar ? 'is-sidebar-resizing' : ''}`}
        style={streamlinedShellStyle}
      >
        <IdeActivityBar identity={sidebarPrimaryIdentity} accountOpen={isIdeAccountOpen}
          active={{ files: !isStreamlinedSidebarCollapsed, document: ideContentTab === 'document',
            assistant: isIdeAssistantVisible && agentMode === 'case', knowledge: isKnowledgeLibraryDialogOpen }}
          onNavigate={handleIdeNavigation}
          onFeedback={() => { setIsIdeAccountOpen(false); handleOpenFeedbackDialog() }}
          onAccount={() => setIsIdeAccountOpen(current => !current)}>
          {isIdeAccountOpen ? <div className="ide-account-backdrop" onClick={() => setIsIdeAccountOpen(false)}>
            <section className="ide-account-popover" aria-label="当前账户"
              onClick={event => event.stopPropagation()}
              onKeyDown={event => {
                if (event.key === 'Escape') setIsIdeAccountOpen(false)
              }}>
              <header className="ide-account-header">
                <span>当前账户</span>
                <button className="ide-account-close" type="button" onClick={() => setIsIdeAccountOpen(false)}>收起</button>
              </header>
              <strong className="ide-account-identity">{sidebarPrimaryIdentity}</strong>
              <div className="ide-account-balance">
                <div className="ide-account-balance-copy">
                  <span>积分余额</span>
                  <strong className={appState!.user.points <= 0 ? 'is-depleted' : undefined}>
                    {appState!.user.points}
                  </strong>
                </div>
                <button className="primary-button ide-account-recharge" type="button"
                  onClick={handleRecharge} disabled={isSubmitting}>充值</button>
              </div>
              <AccountFeatures />
              <footer className="ide-account-actions">
                <button className="ide-account-logout" type="button" onClick={handleLogout}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M10 4H5v16h5 M14 8l4 4-4 4 M9 12h9" />
                  </svg>
                  <span>退出登录</span>
                </button>
              </footer>
            </section>
          </div> : null}
        </IdeActivityBar>
        {renderCaseCenterSidebar()}
        <div
          className="streamlined-shell-resizer"
          onPointerDown={handleStartStreamlinedSidebarResize}
          onDoubleClick={handleResetStreamlinedSidebarWidth}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整证据目录宽度"
          tabIndex={0}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            setStreamlinedSidebarWidth(width => clampStreamlinedSidebarWidth(width + (event.key === 'ArrowRight' ? 20 : -20),
              streamlinedShellRef.current?.clientWidth))
          }}
        />

        <main className="main-content streamlined-main">
          {errorMessage ? (
            <section className="notice-bar error-bar">
              {errorMessage}
            </section>
          ) : null}

          {renderCaseCenterContent()}
        </main>
        {renderKnowledgeLibraryDialog()}
        {renderRechargeDialog()}
        {renderFeedbackDialog()}
        {renderCaseDialog()}
        {authToken ? appState.cases.map(folder => <CaseDirectorySync key={`${loginAccount}:${folder.id}`}
          account={loginAccount} caseId={folder.id}
          enabled={folder.agent?.autoAnalyze !== false && !isSubmitting && !directoryPreparation && !autoLinkingCertificateId}
          onWorkspace={workspace => applyWorkspace(workspace, { selectedCaseId }, { preserveManualPreview: true })}
          onError={setErrorMessage} />) : null}
        {renderImageViewer()}
      </div>
    )
  }

  return (
    <div className="app-shell pro-shell">
      {activeTab === 'workspace'
        ? renderCaseCenterSidebar()
        : activeTab === 'knowledge'
          ? renderKnowledgeSidebar()
          : activeTab === 'settings'
            ? renderSettingsSidebar()
          : renderWorkbenchSidebar()}

      <main className="main-content">
        <section className="nav-strip">
          {[
            ['overview', '工作台'],
            ['workspace', '案件中心'],
            ['knowledge', '知识库'],
            ['settings', '设置'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`nav-pill ${activeTab === key ? 'active' : ''}`}
              type="button"
              onClick={() => setActiveTab(key as AppTab)}
            >
              {label}
            </button>
          ))}
        </section>

        {activeTab === 'workspace' ? (
          <section className="tab-row section-nav">
            {[
              ['overview', '案件概览'],
              ['evidence', '证据材料'],
              ['draft', '质证书起草'],
              ['review', '核验定稿'],
            ].map(([key, label]) => (
              <button
                key={key}
                className={caseCenterTab === key ? 'active' : ''}
                type="button"
                onClick={() => setCaseCenterTab(key as CaseCenterTab)}
              >
                {label}
              </button>
            ))}
          </section>
        ) : null}

        {activeTab === 'settings' ? (
          <section className="tab-row section-nav">
            <button className="active" type="button">
              知识文件
            </button>
          </section>
        ) : null}

        {errorMessage ? (
          <section className="notice-bar error-bar">
            {errorMessage}
          </section>
        ) : null}

        {activeTab === 'overview' ? (
          shouldShowEmptyCaseOnboarding ? (
            <section className="grid-two">
              <article className="panel pro-card case-entry-onboarding-card">
                <div className="panel-header">
                  <div>
                    <span className="eyebrow">首次进入</span>
                    <h2>先新建案件，再链接本地材料</h2>
                  </div>
                </div>
                <p className="case-entry-onboarding-copy">
                  当前账号还没有案件。先建立一个案件，再把电脑里的材料目录接进来，后续证据整理、起草和核验才会进入连续流程。
                </p>
                <div className="case-entry-onboarding-actions">
                  <button className="primary-button" type="button" onClick={handleOpenCreateCaseDialog} disabled={isSubmitting}>
                    新建案件
                  </button>
                </div>
                <div className="architecture-summary case-entry-onboarding-steps">
                  <article>
                    <strong>1. 新建案件</strong>
                    <p>用当事人或案由命名，方便后续切换与检索。</p>
                  </article>
                  <article>
                    <strong>2. 链接本地文件夹</strong>
                    <p>直接选择电脑里的案件材料目录，系统会自动把文件接入证据库。</p>
                  </article>
                  <article>
                    <strong>3. 开始起草</strong>
                    <p>导入完成后就可以继续生成质证书并逐段核验。</p>
                  </article>
                </div>
              </article>
            </section>
          ) : (
            <>
              <section className="stats-grid">
                <article className="stat-card">
                  <span>案件数</span>
                  <strong>{appState.cases.length}</strong>
                </article>
                <article className="stat-card">
                  <span>当前案件证据</span>
                  <strong>{caseEvidences.length}</strong>
                </article>
                <article className="stat-card">
                  <span>质证书版本</span>
                  <strong>{caseCertificates.length}</strong>
                </article>
                <article className="stat-card">
                  <span>法律与案例引用</span>
                  <strong>
                    {activeCertificate?.paragraphs.filter((item) => getParagraphReferences(item).length > 0).length ?? 0}/
                    {activeCertificate?.paragraphs.length ?? 0}
                  </strong>
                </article>
              </section>

              <section className="grid-two">
                <article className="panel pro-card">
                  <div className="panel-header">
                    <div>
                      <span className="eyebrow">当前案件</span>
                      <h2>{selectedCase?.name ?? '请先创建案件'}</h2>
                    </div>
                    {selectedCase ? (
                      <span className={`status-chip ${selectedCase.status}`}>
                        {getStatusLabel(selectedCase.status)}
                      </span>
                    ) : null}
                  </div>
                  <textarea
                    className="description-box"
                    value={selectedCase?.description ?? ''}
                    onChange={(event) => {
                      void handleUpdateCaseDescription(event.target.value)
                    }}
                    placeholder="填写案件背景、争议焦点、庭审目标"
                  />
                </article>

                <article className="panel pro-card">
                  <div className="panel-header">
                    <div>
                      <span className="eyebrow">案件进度</span>
                      <h2>当前核验状态</h2>
                    </div>
                  </div>
                  <div className="architecture-summary">
                    <article>
                      <strong>已核验段落</strong>
                      <p>{verifiedParagraphCount} 段已完成人工核验，可继续补充批注和修改表述。</p>
                    </article>
                    <article>
                      <strong>待补关联</strong>
                      <p>{unlinkedParagraphCount} 段尚未绑定证据，建议优先补齐证据锚点。</p>
                    </article>
                    <article>
                      <strong>最新案件</strong>
                      <p>{recentCases[0]?.name ?? '暂无案件'}，可进入案件中心继续整理材料。</p>
                    </article>
                  </div>
                </article>
              </section>

              <section className="grid-two">
                <article className="panel pro-card">
                  <div className="panel-header">
                    <div>
                      <span className="eyebrow">平台能力</span>
                      <h2>核心流程</h2>
                    </div>
                  </div>
                  <ul className="plain-list">
                    <li>案件立项后集中管理证据、质证书版本和核验进度</li>
                    <li>支持图片、PDF、Word、文本材料统一进入证据库</li>
                    <li>支持基于勾选证据生成不同角色下的质证意见草稿</li>
                    <li>支持逐段核验、人工批注、重绑或解绑证据关联</li>
                    <li>支持把法院案例与法律条文直接绑定到当前段落</li>
                  </ul>
                </article>

                <article className="panel pro-card">
                  <div className="panel-header">
                    <div>
                    <span className="eyebrow">知识库</span>
                      <h2>当前可用专业知识</h2>
                    </div>
                  </div>
                  <ul className="plain-list">
                    <li>法院案例库：{appState.knowledgeCases.length} 条类案与裁判观点</li>
                    <li>法律条文库：{appState.knowledgeStatutes.length} 部法律文件</li>
                    <li>当前段落已绑定：法条 {activeStatuteReferences.length} 条，案例 {activeCaseReferences.length} 条</li>
                    <li>进入知识库页可继续检索、查看全文并绑定到当前段落</li>
                  </ul>
                </article>
              </section>
            </>
          )
        ) : null}

        {activeTab === 'workspace' ? renderCaseCenterContent() : null}

        {activeTab === 'knowledge' ? renderKnowledgeCenter() : null}

        {activeTab === 'settings' ? renderSettingsCenter() : null}
      </main>
      {renderRechargeDialog()}
      {renderFeedbackDialog()}
      {renderCaseDialog()}
      {renderAgentDock()}
      {renderImageViewer()}
    </div>
  )
}

export default App
