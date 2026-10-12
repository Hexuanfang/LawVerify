import { randomUUID } from 'node:crypto'

import type { AuthenticatedActor } from './commercial/types.js'
import { AppError } from './core/app-error.js'
import { readDevStore, updateDevStore } from './infrastructure/dev-store.js'
import { isDatabaseEnabled, query } from './infrastructure/postgres.js'

export type UserFeedbackType = 'bug' | 'suggestion' | 'experience' | 'other'
export type UserFeedbackStatus = 'pending' | 'reviewing' | 'resolved' | 'ignored'

type TrendPoint = {
  date: string
  label: string
  value: number
}

type FeedbackRow = {
  id: string
  organization_id: string
  user_id: string
  membership_id: string | null
  user_email: string
  user_name: string
  source: 'desktop_app'
  feedback_type: UserFeedbackType
  title: string
  content: string
  contact: string | null
  app_version: string | null
  client_platform: string | null
  page_context: string | null
  case_name: string | null
  status: UserFeedbackStatus
  admin_note: string | null
  created_at: string
  updated_at: string
  handled_at: string | null
  handled_by_email: string | null
}

type FeedbackItem = {
  id: string
  organizationId: string
  userId: string
  membershipId?: string
  userEmail: string
  userName: string
  source: 'desktop_app'
  feedbackType: UserFeedbackType
  feedbackTypeLabel: string
  title: string
  content: string
  contact?: string
  appVersion?: string
  clientPlatform?: string
  pageContext?: string
  caseName?: string
  status: UserFeedbackStatus
  statusLabel: string
  adminNote?: string
  createdAt: string
  updatedAt: string
  handledAt?: string
  handledByEmail?: string
}

const FEEDBACK_TYPE_LABELS: Record<UserFeedbackType, string> = {
  bug: '问题反馈',
  suggestion: '功能建议',
  experience: '体验评价',
  other: '其他',
}

const FEEDBACK_STATUS_LABELS: Record<UserFeedbackStatus, string> = {
  pending: '待处理',
  reviewing: '处理中',
  resolved: '已解决',
  ignored: '暂不处理',
}

const FEEDBACK_TREND_DAYS = 30

function normalizeOptionalText(value?: string | null) {
  const nextValue = value?.trim()
  return nextValue ? nextValue : undefined
}

function toDateKey(date: Date | string) {
  const current = typeof date === 'string' ? new Date(date) : date
  const year = current.getFullYear()
  const month = String(current.getMonth() + 1).padStart(2, '0')
  const day = String(current.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toDateLabel(date: Date | string) {
  const current = typeof date === 'string' ? new Date(date) : date
  const month = String(current.getMonth() + 1).padStart(2, '0')
  const day = String(current.getDate()).padStart(2, '0')
  return `${month}-${day}`
}

function getTrendDates(days = FEEDBACK_TREND_DAYS) {
  const dates: Date[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - index)
    dates.push(date)
  }
  return dates
}

function buildDailyTrend(items: FeedbackItem[], days = FEEDBACK_TREND_DAYS): TrendPoint[] {
  const dailyCounts = new Map<string, number>()
  const windowStartKey = toDateKey(getTrendDates(days)[0])

  for (const item of items) {
    const key = toDateKey(item.createdAt)
    if (key < windowStartKey) {
      continue
    }
    dailyCounts.set(key, (dailyCounts.get(key) ?? 0) + 1)
  }

  return getTrendDates(days).map((date) => {
    const key = toDateKey(date)
    return {
      date: key,
      label: toDateLabel(date),
      value: dailyCounts.get(key) ?? 0,
    }
  })
}

function mapFeedbackRow(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    membershipId: normalizeOptionalText(row.membership_id) ?? undefined,
    userEmail: row.user_email,
    userName: row.user_name,
    source: row.source,
    feedbackType: row.feedback_type,
    feedbackTypeLabel: FEEDBACK_TYPE_LABELS[row.feedback_type],
    title: row.title,
    content: row.content,
    contact: normalizeOptionalText(row.contact),
    appVersion: normalizeOptionalText(row.app_version),
    clientPlatform: normalizeOptionalText(row.client_platform),
    pageContext: normalizeOptionalText(row.page_context),
    caseName: normalizeOptionalText(row.case_name),
    status: row.status,
    statusLabel: FEEDBACK_STATUS_LABELS[row.status],
    adminNote: normalizeOptionalText(row.admin_note),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    handledAt: normalizeOptionalText(row.handled_at),
    handledByEmail: normalizeOptionalText(row.handled_by_email),
  }
}

function sortFeedbackItems(items: FeedbackItem[]) {
  return [...items].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
}

function buildTopKeywords(items: FeedbackItem[]) {
  const stopWords = new Set([
    '一个', '一些', '已经', '还是', '现在', '希望', '建议', '反馈', '问题', '功能', '目前', '这里', '这个',
    '那个', '点击', '页面', '模块', '内容', '时候', '进行', '无法', '不能', '使用', 'LawVerify', 'lawverify',
    '桌面端', '客户端', '用户', '里面', '显示', '处理', '需要', '感觉', '支持', '提交', '账号', '系统',
  ])
  const counts = new Map<string, number>()
  const text = items.map((item) => `${item.title} ${item.content}`).join('\n')
  const matches = text.match(/[\u4e00-\u9fa5]{2,8}|[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []

  for (const raw of matches) {
    const keyword = raw.trim()
    if (!keyword || stopWords.has(keyword)) {
      continue
    }
    counts.set(keyword, (counts.get(keyword) ?? 0) + 1)
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
    .slice(0, 12)
    .map(([keyword, count]) => ({ keyword, count }))
}

function buildFeedbackInsights(items: FeedbackItem[]) {
  const sortedItems = sortFeedbackItems(items)
  const trend = buildDailyTrend(sortedItems)
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setHours(0, 0, 0, 0)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6)
  const sevenDayKey = toDateKey(sevenDaysAgo)

  const overview = {
    totalCount: sortedItems.length,
    pendingCount: sortedItems.filter((item) => item.status === 'pending').length,
    reviewingCount: sortedItems.filter((item) => item.status === 'reviewing').length,
    resolvedCount: sortedItems.filter((item) => item.status === 'resolved').length,
    ignoredCount: sortedItems.filter((item) => item.status === 'ignored').length,
    last7DaysCount: sortedItems.filter((item) => toDateKey(item.createdAt) >= sevenDayKey).length,
    bugCount: sortedItems.filter((item) => item.feedbackType === 'bug').length,
    suggestionCount: sortedItems.filter((item) => item.feedbackType === 'suggestion').length,
  }

  const typeStats = (Object.keys(FEEDBACK_TYPE_LABELS) as UserFeedbackType[]).map((key) => ({
    key,
    label: FEEDBACK_TYPE_LABELS[key],
    count: sortedItems.filter((item) => item.feedbackType === key).length,
  }))

  const statusStats = (Object.keys(FEEDBACK_STATUS_LABELS) as UserFeedbackStatus[]).map((key) => ({
    key,
    label: FEEDBACK_STATUS_LABELS[key],
    count: sortedItems.filter((item) => item.status === key).length,
  }))

  const versionMap = new Map<string, number>()
  for (const item of sortedItems) {
    const version = item.appVersion || '未知版本'
    versionMap.set(version, (versionMap.get(version) ?? 0) + 1)
  }
  const versionStats = Array.from(versionMap.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
    .slice(0, 8)
    .map(([version, count]) => ({ version, count }))

  const topUserMap = new Map<string, { name: string; email: string; count: number; lastSubmittedAt: string }>()
  for (const item of sortedItems) {
    const current = topUserMap.get(item.userEmail)
    if (!current) {
      topUserMap.set(item.userEmail, {
        name: item.userName,
        email: item.userEmail,
        count: 1,
        lastSubmittedAt: item.createdAt,
      })
      continue
    }

    current.count += 1
    if (current.lastSubmittedAt < item.createdAt) {
      current.lastSubmittedAt = item.createdAt
    }
  }
  const topUsers = Array.from(topUserMap.values())
    .sort((left, right) => right.count - left.count || right.lastSubmittedAt.localeCompare(left.lastSubmittedAt))
    .slice(0, 6)

  return {
    overview,
    trend,
    typeStats,
    statusStats,
    versionStats,
    topUsers,
    topKeywords: buildTopKeywords(sortedItems),
    items: sortedItems.slice(0, 100),
  }
}

async function readAllFeedbackItems() {
  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    return sortFeedbackItems(
      store.userFeedbacks.map((item) => ({
        id: item.id,
        organizationId: item.organizationId,
        userId: item.userId,
        membershipId: item.membershipId,
        userEmail: item.userEmail,
        userName: item.userName,
        source: item.source,
        feedbackType: item.feedbackType,
        feedbackTypeLabel: FEEDBACK_TYPE_LABELS[item.feedbackType],
        title: item.title,
        content: item.content,
        contact: normalizeOptionalText(item.contact),
        appVersion: normalizeOptionalText(item.appVersion),
        clientPlatform: normalizeOptionalText(item.clientPlatform),
        pageContext: normalizeOptionalText(item.pageContext),
        caseName: normalizeOptionalText(item.caseName),
        status: item.status,
        statusLabel: FEEDBACK_STATUS_LABELS[item.status],
        adminNote: normalizeOptionalText(item.adminNote),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        handledAt: normalizeOptionalText(item.handledAt),
        handledByEmail: normalizeOptionalText(item.handledByEmail),
      })),
    )
  }

  const result = await query<FeedbackRow>(`
    SELECT
      id::text,
      organization_id::text,
      user_id::text,
      membership_id::text,
      user_email,
      user_name,
      source,
      feedback_type,
      title,
      content,
      contact,
      app_version,
      client_platform,
      page_context,
      case_name,
      status,
      admin_note,
      created_at::text,
      updated_at::text,
      handled_at::text,
      handled_by_email
    FROM user_feedback
    ORDER BY created_at DESC
  `)

  return result.rows.map(mapFeedbackRow)
}

export async function createUserFeedback(
  actor: AuthenticatedActor,
  input: {
    feedbackType: UserFeedbackType
    title: string
    content: string
    contact?: string
    appVersion?: string
    clientPlatform?: string
    pageContext?: string
    caseName?: string
  },
) {
  const title = input.title.trim()
  const content = input.content.trim()
  const contact = normalizeOptionalText(input.contact)
  const appVersion = normalizeOptionalText(input.appVersion)
  const clientPlatform = normalizeOptionalText(input.clientPlatform)
  const pageContext = normalizeOptionalText(input.pageContext)
  const caseName = normalizeOptionalText(input.caseName)
  const now = new Date().toISOString()

  if (!isDatabaseEnabled()) {
    return updateDevStore((store) => {
      const user = store.users.find((item) => item.id === actor.userId && item.status === 'active')
      if (!user) {
        throw new AppError('当前账号不存在。', 404, 'ACCOUNT_NOT_FOUND')
      }

      const nextItem = {
        id: `feedback-${randomUUID()}`,
        organizationId: actor.organizationId,
        userId: actor.userId,
        membershipId: actor.membershipId,
        userEmail: actor.email,
        userName: user.name,
        source: 'desktop_app' as const,
        feedbackType: input.feedbackType,
        title,
        content,
        contact,
        appVersion,
        clientPlatform,
        pageContext,
        caseName,
        status: 'pending' as const,
        createdAt: now,
        updatedAt: now,
      }

      store.userFeedbacks.unshift(nextItem)

      return {
        item: {
          ...nextItem,
          feedbackTypeLabel: FEEDBACK_TYPE_LABELS[nextItem.feedbackType],
          statusLabel: FEEDBACK_STATUS_LABELS[nextItem.status],
        },
      }
    })
  }

  const userResult = await query<{ id: string; name: string; email: string }>(
    'SELECT id::text, name, email FROM users WHERE id = $1::uuid LIMIT 1',
    [actor.userId],
  )
  const user = userResult.rows[0]
  if (!user) {
    throw new AppError('当前账号不存在。', 404, 'ACCOUNT_NOT_FOUND')
  }

  const insertResult = await query<FeedbackRow>(`
    INSERT INTO user_feedback (
      organization_id,
      user_id,
      membership_id,
      user_email,
      user_name,
      source,
      feedback_type,
      title,
      content,
      contact,
      app_version,
      client_platform,
      page_context,
      case_name,
      status,
      created_at,
      updated_at
    ) VALUES (
      $1::uuid,
      $2::uuid,
      $3::uuid,
      $4,
      $5,
      'desktop_app',
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      'pending',
      $14::timestamptz,
      $14::timestamptz
    )
    RETURNING
      id::text,
      organization_id::text,
      user_id::text,
      membership_id::text,
      user_email,
      user_name,
      source,
      feedback_type,
      title,
      content,
      contact,
      app_version,
      client_platform,
      page_context,
      case_name,
      status,
      admin_note,
      created_at::text,
      updated_at::text,
      handled_at::text,
      handled_by_email
  `, [
    actor.organizationId,
    actor.userId,
    actor.membershipId,
    actor.email,
    user.name,
    input.feedbackType,
    title,
    content,
    contact ?? null,
    appVersion ?? null,
    clientPlatform ?? null,
    pageContext ?? null,
    caseName ?? null,
    now,
  ])

  return {
    item: mapFeedbackRow(insertResult.rows[0]),
  }
}

export async function getAdminFeedbackInsights() {
  const items = await readAllFeedbackItems()
  return buildFeedbackInsights(items)
}

export async function updateAdminFeedbackStatus(
  actor: AuthenticatedActor,
  feedbackId: string,
  input: {
    status: UserFeedbackStatus
    adminNote?: string
  },
) {
  const feedbackKey = feedbackId.trim()
  if (!feedbackKey) {
    throw new AppError('缺少反馈记录 ID。', 400, 'FEEDBACK_ID_REQUIRED')
  }

  const status = input.status
  const adminNote = normalizeOptionalText(input.adminNote)
  const now = new Date().toISOString()
  const handledAt = status === 'pending' ? undefined : now
  const handledByEmail = status === 'pending' ? undefined : actor.email

  if (!isDatabaseEnabled()) {
    return updateDevStore((store) => {
      const item = store.userFeedbacks.find((entry) => entry.id === feedbackKey)
      if (!item) {
        throw new AppError('未找到对应的反馈记录。', 404, 'FEEDBACK_NOT_FOUND')
      }

      item.status = status
      item.adminNote = adminNote
      item.updatedAt = now
      item.handledAt = handledAt
      item.handledByEmail = handledByEmail

      return {
        item: {
          ...item,
          feedbackTypeLabel: FEEDBACK_TYPE_LABELS[item.feedbackType],
          statusLabel: FEEDBACK_STATUS_LABELS[item.status],
        },
      }
    })
  }

  const updateResult = await query<FeedbackRow>(`
    UPDATE user_feedback
    SET
      status = $2,
      admin_note = $3,
      updated_at = $4::timestamptz,
      handled_at = $5::timestamptz,
      handled_by_email = $6
    WHERE id = $1::uuid
    RETURNING
      id::text,
      organization_id::text,
      user_id::text,
      membership_id::text,
      user_email,
      user_name,
      source,
      feedback_type,
      title,
      content,
      contact,
      app_version,
      client_platform,
      page_context,
      case_name,
      status,
      admin_note,
      created_at::text,
      updated_at::text,
      handled_at::text,
      handled_by_email
  `, [
    feedbackKey,
    status,
    adminNote ?? null,
    now,
    handledAt ?? null,
    handledByEmail ?? null,
  ])

  if (!updateResult.rowCount) {
    throw new AppError('未找到对应的反馈记录。', 404, 'FEEDBACK_NOT_FOUND')
  }

  return {
    item: mapFeedbackRow(updateResult.rows[0]),
  }
}
