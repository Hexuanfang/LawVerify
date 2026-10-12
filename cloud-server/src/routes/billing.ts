import { Router } from 'express'
import { z } from 'zod'

import {
  completeRechargePaymentOrderForDevelopment,
  createRechargePaymentOrder,
  getBillingCatalog,
  getRechargePaymentOrder,
  handlePaymentCallback,
  listRechargePaymentOrders,
} from '../billing-service.js'
import {
  decryptWechatNotificationResource,
  isDevPaymentSimulationEnabled,
  shouldVerifyGatewayCallback,
  verifyAlipayCallbackSignature,
  verifyWechatCallbackSignature,
} from '../integrations/payment.js'
import { sendSuccess } from '../http.js'
import { authenticate, requirePermission } from '../middleware/authenticate.js'
import { sitePlans } from '../mock-data.js'

const createOrderSchema = z.object({
  packageId: z.string().min(1, 'packageId is required.'),
  channel: z.enum(['alipay', 'wechat']),
})

export const billingRouter = Router()

billingRouter.get('/plans', (_request, response) => {
  sendSuccess(response, {
    items: sitePlans,
  })
})

billingRouter.get('/catalog', async (_request, response) => {
  const result = await getBillingCatalog()
  sendSuccess(response, result)
})

billingRouter.get('/orders', authenticate, requirePermission('billing.read'), async (request, response) => {
  const limit = Number.parseInt(String(request.query.limit ?? '50'), 10)
  const result = await listRechargePaymentOrders(request.actor!, Number.isNaN(limit) ? 50 : limit)
  sendSuccess(response, result)
})

billingRouter.get('/orders/:orderId', authenticate, requirePermission('billing.read'), async (request, response) => {
  const result = await getRechargePaymentOrder(request.actor!, String(request.params.orderId))
  sendSuccess(response, result)
})

billingRouter.post('/orders', authenticate, requirePermission('billing.manage'), async (request, response) => {
  const payload = createOrderSchema.parse(request.body ?? {})
  const result = await createRechargePaymentOrder(request.actor!, payload)
  sendSuccess(response, result)
})

billingRouter.post('/orders/:orderId/dev-complete', authenticate, requirePermission('billing.manage'), async (request, response) => {
  if (!isDevPaymentSimulationEnabled()) {
    response.status(404).json({
      success: false,
      error: {
        message: '当前环境未启用开发态模拟支付。',
      },
    })
    return
  }

  const result = await completeRechargePaymentOrderForDevelopment(request.actor!, String(request.params.orderId))
  sendSuccess(response, result)
})

billingRouter.post('/callbacks/alipay', async (request, response) => {
  const payload = (request.body ?? {}) as Record<string, unknown>
  if (shouldVerifyGatewayCallback('alipay') && !verifyAlipayCallbackSignature(payload)) {
    response.status(400).type('text/plain').send('invalid sign')
    return
  }

  await handlePaymentCallback({
    provider: 'alipay',
    outTradeNo: typeof payload.out_trade_no === 'string' ? payload.out_trade_no : undefined,
    providerOrderId: typeof payload.trade_no === 'string' ? payload.trade_no : undefined,
    status: payload.trade_status === 'TRADE_SUCCESS' || payload.trade_status === 'TRADE_FINISHED' ? 'paid' : 'pending',
    paidAt: typeof payload.gmt_payment === 'string'
      ? new Date(payload.gmt_payment.replace(' ', 'T')).toISOString()
      : undefined,
    providerMessage: typeof payload.trade_status === 'string' ? payload.trade_status : 'UNKNOWN',
    payload,
  })
  response.type('text/plain').send('success')
})

billingRouter.post('/callbacks/wechat', async (request, response) => {
  const payload = (request.body ?? {}) as Record<string, unknown>
  const rawBody = (request as typeof request & { rawBody?: string }).rawBody ?? JSON.stringify(payload)
  if (
    shouldVerifyGatewayCallback('wechat')
    && !verifyWechatCallbackSignature({
      timestamp: request.header('wechatpay-timestamp') ?? undefined,
      nonce: request.header('wechatpay-nonce') ?? undefined,
      signature: request.header('wechatpay-signature') ?? undefined,
      serial: request.header('wechatpay-serial') ?? undefined,
      rawBody,
    })
  ) {
    response.status(400).json({
      code: 'FAIL',
      message: 'invalid signature',
    })
    return
  }

  const resource = payload.resource as {
    associated_data?: string
    nonce?: string
    ciphertext?: string
  } | undefined

  let decoded: Record<string, unknown> = {}
  if (resource?.nonce && resource.ciphertext) {
    decoded = decryptWechatNotificationResource({
      associated_data: resource.associated_data,
      nonce: resource.nonce,
      ciphertext: resource.ciphertext,
    }) as Record<string, unknown>
  }

  await handlePaymentCallback({
    provider: 'wechat',
    outTradeNo: typeof decoded.out_trade_no === 'string' ? decoded.out_trade_no : undefined,
    providerOrderId: typeof decoded.transaction_id === 'string' ? decoded.transaction_id : undefined,
    status: decoded.trade_state === 'SUCCESS' ? 'paid' : 'pending',
    paidAt: typeof decoded.success_time === 'string' ? decoded.success_time : undefined,
    providerMessage: typeof decoded.trade_state === 'string' ? decoded.trade_state : 'NOTIFY_RECEIVED',
    payload: {
      notify: payload,
      decoded,
    },
  })

  sendSuccess(response, { code: 'SUCCESS', message: '成功' })
})
