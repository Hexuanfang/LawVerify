import { Router } from 'express'
import { z } from 'zod'

import { getBillingAccountSummary, getDesktopDevelopmentSyncByEmail, listRechargePaymentOrders } from '../billing-service.js'
import { sendSuccess } from '../http.js'
import { isDevPaymentSimulationEnabled } from '../integrations/payment.js'

export const clientRouter = Router()

const desktopSyncQuerySchema = z.object({
  email: z.string().email('请输入正确的账户邮箱。'),
})

clientRouter.get('/account-summary', async (_request, response) => {
  const account = await getBillingAccountSummary()
  sendSuccess(response, {
    displayName: account.displayName,
    tierName: account.tierName,
    pointsBalance: account.pointsBalance,
    subscriptionExpiresAt: account.subscriptionExpiresAt,
  })
})

clientRouter.get('/entitlements', async (_request, response) => {
  const account = await getBillingAccountSummary()
  sendSuccess(response, {
    tierName: account.tierName,
    pointsBalance: account.pointsBalance,
    desktopAccess: true,
  })
})

clientRouter.get('/orders/latest', async (_request, response) => {
  const result = await listRechargePaymentOrders(undefined, 5)
  sendSuccess(response, result)
})

clientRouter.get('/desktop-sync', async (request, response) => {
  if (!isDevPaymentSimulationEnabled()) {
    response.status(404).json({
      success: false,
      error: {
        message: '当前环境未启用桌面端开发同步。',
      },
    })
    return
  }

  const query = desktopSyncQuerySchema.parse({
    email: typeof request.query.email === 'string' ? request.query.email : '',
  })

  const result = await getDesktopDevelopmentSyncByEmail(query.email)
  sendSuccess(response, result)
})
