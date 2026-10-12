import { Router } from 'express'
import { z } from 'zod'

import { getAdminDashboard, getAdminUsers, getAdminUsage } from '../admin-service.js'
import { getAdminFeedbackInsights, updateAdminFeedbackStatus } from '../feedback-service.js'
import { authenticate, requirePlatformAdmin } from '../middleware/authenticate.js'

export const adminRouter = Router()

const feedbackUpdateSchema = z.object({
  status: z.enum(['pending', 'reviewing', 'resolved', 'ignored']),
  adminNote: z.string().max(500, '管理员备注请控制在 500 字以内。').optional(),
})

adminRouter.use(authenticate)
adminRouter.use(requirePlatformAdmin)

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
