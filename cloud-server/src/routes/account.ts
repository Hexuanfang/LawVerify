import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { changeAccountPassword, getCurrentActorProfile, loginAccount, loginPhoneAccount, logoutAccount, registerAccount, updateAccountProfile, verifyToken } from '../commercial/auth-service.js'
import { sendPhoneCode, withVerifiedPhoneCode } from '../commercial/phone-code.js'
import { createUserFeedback } from '../feedback-service.js'
import { getBillingAccountSummary, getUsageSummary, listRechargePointLedger } from '../billing-service.js'
import { sendSuccess } from '../http.js'
import { authenticate, isPlatformAdminEmail, requirePermission } from '../middleware/authenticate.js'
import { consumePointAction, listPointPolicies, quotePointAction, refundPointAction } from '../point-service.js'
import { getReferralSummary } from '../referral-service.js'
import { eventBatchSchema, getAnalyticsPreference, ingestProductEvents, setAnalyticsPreference } from '../analytics-service.js'
import { isAllowedRegistrationEmail } from '../commercial/admin-identifiers.js'
import { issueParserTicket } from '../parser-ticket.js'

const registerSchema = z.object({
  organizationName: z.string().min(2, '机构名称至少 2 个字。'),
  ownerName: z.string().trim().min(2, '姓名或昵称至少 2 个字符。').optional(),
  email: z.string().trim().min(1, '请输入邮箱或管理员账号标识。')
    .refine(isAllowedRegistrationEmail, '请输入正确的邮箱地址，或使用管理员账号标识。'),
  password: z.string().min(6, '密码至少 6 位。'),
  inviteCode: z.string().trim().regex(/^[A-Fa-f0-9]{16}$/).optional(),
})

const loginSchema = z.object({
  email: z.string().min(1, '请输入注册邮箱。'),
  password: z.string().min(6, '密码至少 6 位。'),
})

const phoneSchema = z.string().trim().regex(/^1[3-9]\d{9}$/, '请输入正确的中国大陆手机号。')
const smsSendSchema = z.object({ phone: phoneSchema, purpose: z.enum(['register', 'login']) })
const phoneLoginSchema = z.object({
  phone: phoneSchema,
  challengeId: z.uuid('请先获取短信验证码。'),
  code: z.string().trim().regex(/^\d{6}$/, '请输入 6 位短信验证码。'),
})
const phoneRegisterSchema = registerSchema.omit({ email: true, password: true }).extend(phoneLoginSchema.shape)

const profileSchema = z.strictObject({
  displayName: z.string().trim().min(1, '请输入显示名称。').max(24, '显示名称最多 24 个字符。').optional(),
  organizationName: z.string().trim().min(2, '律所 / 单位名称至少 2 个字。').max(48, '律所 / 单位名称最多 48 个字符。').optional(),
}).refine(value => value.displayName !== undefined || value.organizationName !== undefined, '请提供要保存的账号资料。')

const passwordSchema = z.strictObject({
  currentPassword: z.string().min(1, '请输入当前密码。').max(1024),
  newPassword: z.string().min(8, '新密码至少 8 位。').refine(value => Buffer.byteLength(value, 'utf8') <= 72, '新密码长度超过 72 字节。'),
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

accountRouter.post('/parser-ticket', authenticate, requirePermission('account.read'), (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  sendSuccess(response, issueParserTicket(request.actor!))
})

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
  await sendLoginResult(request, response, await loginAccount(payload), started)
})

accountRouter.post('/sms/send', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  const { phone, purpose } = smsSendSchema.parse(request.body ?? {})
  sendSuccess(response, await sendPhoneCode(phone, purpose, request.ip ?? request.socket.remoteAddress ?? 'unknown'))
})

accountRouter.post('/phone/register', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  const { phone, challengeId, code, ...details } = phoneRegisterSchema.parse(request.body ?? {})
  sendSuccess(response, await withVerifiedPhoneCode({ phone, challengeId, code }, 'register',
    client => registerAccount({ ...details, phone, client })))
})

accountRouter.post('/phone/login', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  const started = Date.now()
  const payload = phoneLoginSchema.parse(request.body ?? {})
  const result = await withVerifiedPhoneCode(payload, 'login', client => loginPhoneAccount(payload.phone, client))
  await sendLoginResult(request, response, result, started)
})

async function sendLoginResult(request: Request, response: Response, result: Awaited<ReturnType<typeof loginAccount>>, started: number) {
  const claims = verifyToken(result.token)
  await ingestProductEvents({ userId: claims.sub, organizationId: claims.organizationId, membershipId: claims.membershipId,
    role: claims.role, email: claims.email, sessionId: claims.sessionId }, [{
    id: randomUUID(), name: 'auth.login', surface: request.header('x-product-surface') === 'desktop' ? 'desktop' : 'web',
    outcome: 'success', durationMs: Math.min(3600000, Date.now() - started),
  }]).catch(() => {})
  sendSuccess(response, { ...result, isPlatformAdmin: isPlatformAdminEmail(claims.email) })
}

accountRouter.post('/logout', authenticate, async (request, response) => {
  const result = await logoutAccount(request.actor!)
  sendSuccess(response, result)
})

accountRouter.get('/profile', authenticate, requirePermission('account.read'), async (request, response) => {
  const result = await getCurrentActorProfile(request.actor!)
  sendSuccess(response, result)
})

accountRouter.put('/profile', authenticate, requirePermission('account.read'), async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  sendSuccess(response, await updateAccountProfile(request.actor!, profileSchema.parse(request.body ?? {})))
})

accountRouter.put('/password', authenticate, requirePermission('account.read'), async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  sendSuccess(response, await changeAccountPassword(request.actor!, passwordSchema.parse(request.body ?? {})))
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
