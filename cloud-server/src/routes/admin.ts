import { Router } from 'express'
import { z } from 'zod'

import { getAdminDashboard, getAdminUsers, getAdminUsage } from '../admin-service.js'
import { approveCocreateApplication, cocreateSearchSchema, grantCocreatePoints, searchCocreateApplications } from '../cocreate-service.js'
import { AppError } from '../core/app-error.js'
import { getAdminFeedbackInsights, updateAdminFeedbackStatus } from '../feedback-service.js'
import { sendSuccess } from '../http.js'
import { authenticate, requirePlatformAdmin } from '../middleware/authenticate.js'
import { getProductAnalytics } from '../analytics-service.js'

export const adminRouter = Router()

const feedbackUpdateSchema = z.object({
  status: z.enum(['pending', 'reviewing', 'resolved', 'ignored']),
  adminNote: z.string().max(500, '管理员备注请控制在 500 字以内。').optional(),
})
const cocreateGrantSchema = z.strictObject({ idempotencyKey: z.uuidv4(), recipientUserId: z.uuidv4() })

adminRouter.use(authenticate)
adminRouter.use(requirePlatformAdmin)

adminRouter.post('/cocreate/applications/search', async (req, res) => {
  const filters = cocreateSearchSchema.parse(req.body ?? {})
  res.setHeader('Cache-Control', 'no-store')
  sendSuccess(res, await searchCocreateApplications(filters))
})

adminRouter.patch('/cocreate/applications/:id/approve', async (req, res) => {
  const id = z.uuidv4().parse(req.params.id)
  res.setHeader('Cache-Control', 'no-store')
  sendSuccess(res, await approveCocreateApplication(id, req.actor!.userId))
})

adminRouter.post('/cocreate/applications/:id/grant-points', async (req, res) => {
  const id = z.uuidv4().parse(req.params.id)
  const { idempotencyKey, recipientUserId } = cocreateGrantSchema.parse(req.body)
  res.setHeader('Cache-Control', 'no-store')
  const result = await grantCocreatePoints(id, idempotencyKey, recipientUserId, req.actor!.userId).catch(error => {
    if (error instanceof AppError) throw error
    throw new AppError('暂时无法发放积分，请稍后重试。', 500, 'COCREATE_POINTS_UNAVAILABLE')
  })
  sendSuccess(res, result)
})

adminRouter.get('/analytics', async (_req, res) => {
  res.json({ success: true, data: await getProductAnalytics() })
})

adminRouter.get('/dashboard', async (req, res, next) => {
  try {
    const data = await getAdminDashboard()
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/users', async (req, res, next) => {
  try {
    const data = await getAdminUsers()
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/usage', async (req, res, next) => {
  try {
    const data = await getAdminUsage()
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/feedback', async (_req, res, next) => {
  try {
    const data = await getAdminFeedbackInsights()
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

adminRouter.patch('/feedback/:feedbackId', async (req, res, next) => {
  try {
    const payload = feedbackUpdateSchema.parse(req.body ?? {})
    const data = await updateAdminFeedbackStatus(req.actor!, req.params.feedbackId, payload)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})
