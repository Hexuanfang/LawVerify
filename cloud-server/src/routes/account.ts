import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { getCurrentActorProfile, loginAccount, logoutAccount, registerAccount, verifyToken } from '../commercial/auth-service.js'
import { createUserFeedback } from '../feedback-service.js'
import { getBillingAccountSummary, getUsageSummary, listRechargePointLedger } from '../billing-service.js'
import { sendSuccess } from '../http.js'
import { authenticate, requirePermission } from '../middleware/authenticate.js'
import { consumePointAction, listPointPolicies, quotePointAction, refundPointAction } from '../point-service.js'
import { getReferralSummary } from '../referral-service.js'
import { eventBatchSchema, getAnalyticsPreference, ingestProductEvents, setAnalyticsPreference } from '../analytics-service.js'

const registerSchema = z.object({
  organizationName: z.string().min(2, '机构名称至少 2 个字。'),
  ownerName: z.string().min(2, '负责人姓名至少 2 个字。'),
  email: z.string().email('请输入正确的邮箱地址。'),
  password: z.string().min(6, '密码至少 6 位。'),
  inviteCode: z.string().trim().regex(/^[A-Fa-f0-9]{16}$/).optional(),
})

const loginSchema = z.object({
  email: z.string().min(1, '请输入注册邮箱。'),
  password: z.string().min(6, '密码至少 6 位。'),
})

const pointActionSchema = z.object({
  actionType: z.enum([
    'document_parse',
    'evidence_summary',
    'legal_check',
    'case_reference',
    'evidence_match',
    'crosscheck_paragraph',
    'crosscheck_full',
    'pleading_full',
  ]),
  units: z.coerce.number().int().positive().max(500).optional(),
})

const pointConsumeSchema = pointActionSchema.extend({
  idempotencyKey: z.string().min(8, '缺少有效的幂等键。'),
  workspaceId: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  note: z.string().max(120).optional(),
})

const pointRefundSchema = z.object({
  refundOperationKey: z.string().min(8, '缺少有效的退款幂等键。'),
  sourceOperationKey: z.string().min(8).optional(),
  sourceEntryId: z.string().min(1).optional(),
  note: z.string().max(120).optional(),
})

const feedbackCreateSchema = z.object({
  feedbackType: z.enum(['bug', 'suggestion', 'experience', 'other']),
  title: z.string().min(2, '请填写反馈标题。').max(60, '反馈标题请控制在 60 字以内。'),
  content: z.string().min(10, '请尽量描述清楚遇到的问题或建议。').max(2000, '反馈内容请控制在 2000 字以内。'),
  contact: z.string().max(80, '联系方式请控制在 80 字以内。').optional(),
  appVersion: z.string().max(40, '版本号长度不正确。').optional(),
  clientPlatform: z.string().max(80, '平台标识过长。').optional(),
  pageContext: z.string().max(80, '页面上下文过长。').optional(),
  caseName: z.string().max(120, '案件名称过长。').optional(),
})

export const accountRouter = Router()

accountRouter.get('/referrals', authenticate, requirePermission('account.read'), async (req, res) => {
  sendSuccess(res, await getReferralSummary(req.actor!))
})
accountRouter.get('/analytics-preference', authenticate, async (req, res) => {
  sendSuccess(res, await getAnalyticsPreference(req.actor!))
})
accountRouter.put('/analytics-preference', authenticate, async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body)
  sendSuccess(res, await setAnalyticsPreference(req.actor!, enabled))
})
accountRouter.post('/events', authenticate, async (req, res) => {
  const { events } = eventBatchSchema.parse(req.body)
  sendSuccess(res, await ingestProductEvents(req.actor!, events))
})

accountRouter.post('/register', async (request, response) => {
  const payload = registerSchema.parse(request.body ?? {})
  const result = await registerAccount(payload)
  sendSuccess(response, result)
})

accountRouter.post('/login', async (request, response) => {
  const started = Date.now()
  const payload = loginSchema.parse(request.body ?? {})
  const result = await loginAccount(payload)
  const claims = verifyToken(result.token)
  await ingestProductEvents({ userId: claims.sub, organizationId: claims.organizationId, membershipId: claims.membershipId,
    role: claims.role, email: claims.email, sessionId: claims.sessionId }, [{
    id: randomUUID(), name: 'auth.login', surface: request.header('x-product-surface') === 'desktop' ? 'desktop' : 'web',
    outcome: 'success', durationMs: Math.min(3600000, Date.now() - started),
  }]).catch(() => {})
  sendSuccess(response, result)
})

accountRouter.post('/logout', authenticate, async (request, response) => {
  const result = await logoutAccount(request.actor!)
  sendSuccess(response, result)
})

accountRouter.get('/profile', authenticate, requirePermission('account.read'), async (request, response) => {
  const result = await getCurrentActorProfile(request.actor!)
  sendSuccess(response, result)
})

accountRouter.get('/me', authenticate, requirePermission('account.read'), async (request, response) => {
  const account = await getBillingAccountSummary(request.actor!)
  sendSuccess(response, account)
})

accountRouter.get('/entitlements', authenticate, requirePermission('account.read'), async (request, response) => {
  const account = await getBillingAccountSummary(request.actor!)
  sendSuccess(response, {
    tierName: account.tierName,
    pointsBalance: account.pointsBalance,
    subscriptionExpiresAt: account.subscriptionExpiresAt,
    features: ['桌面端登录', '法律依据 RAG', '案例参照', '账户中心订单管理'],
  })
})

accountRouter.get('/usage/summary', authenticate, requirePermission('account.read'), async (request, response) => {
  const result = await getUsageSummary(request.actor!)
  sendSuccess(response, result)
})

accountRouter.get('/points/policies', authenticate, requirePermission('account.read'), async (_request, response) => {
  const result = await listPointPolicies()
  sendSuccess(response, result)
})

accountRouter.post('/points/quote', authenticate, requirePermission('account.read'), async (request, response) => {
  const payload = pointActionSchema.parse(request.body ?? {})
  const result = await quotePointAction(request.actor!, payload)
  sendSuccess(response, result)
})

accountRouter.post('/points/consume', authenticate, requirePermission('account.read'), async (request, response) => {
  const payload = pointConsumeSchema.parse(request.body ?? {})
  const result = await consumePointAction(request.actor!, payload)
  sendSuccess(response, result)
})

accountRouter.post('/points/refund', authenticate, requirePermission('account.read'), async (request, response) => {
  const payload = pointRefundSchema.parse(request.body ?? {})
  const result = await refundPointAction(request.actor!, payload)
  sendSuccess(response, result)
})

accountRouter.get('/point-ledger', authenticate, requirePermission('account.read'), async (request, response) => {
  const result = await listRechargePointLedger(request.actor!, 100)
  sendSuccess(response, result)
})

accountRouter.post('/feedback', authenticate, requirePermission('account.read'), async (request, response) => {
  const payload = feedbackCreateSchema.parse(request.body ?? {})
  const result = await createUserFeedback(request.actor!, payload)
  sendSuccess(response, result)
})
