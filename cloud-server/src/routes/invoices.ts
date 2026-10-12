import { Router } from 'express'
import { z } from 'zod'

import { sendSuccess } from '../http.js'
import { authenticate, requirePermission } from '../middleware/authenticate.js'
import { createInvoiceRequest, listInvoiceProfiles, listInvoiceRequests } from '../invoice-service.js'

export const invoicesRouter = Router()

const createInvoiceRequestSchema = z.object({
  orderId: z.string().min(1).optional(),
  title: z.string().min(2, '企业名称至少 2 个字。'),
  taxNo: z.string().min(10, '请输入正确的纳税人识别号。'),
  registeredAddress: z.string().min(5, '请输入企业注册地址。'),
  registeredPhone: z.string().min(6, '请输入企业注册电话。'),
  bankName: z.string().min(2, '请输入开户银行。'),
  bankAccount: z.string().min(8, '请输入银行账号。'),
  recipientEmail: z.string().email('请输入正确的收票邮箱。').optional().or(z.literal('')),
})

invoicesRouter.get('/profiles', authenticate, requirePermission('invoice.read'), async (request, response) => {
  const result = await listInvoiceProfiles(request.actor!)
  sendSuccess(response, result)
})

invoicesRouter.get('/requests', authenticate, requirePermission('invoice.read'), async (request, response) => {
  const result = await listInvoiceRequests(request.actor!)
  sendSuccess(response, result)
})

invoicesRouter.post('/requests', authenticate, requirePermission('invoice.read'), async (request, response) => {
  const payload = createInvoiceRequestSchema.parse(request.body ?? {})
  const result = await createInvoiceRequest(request.actor!, payload)
  sendSuccess(response, result)
})
