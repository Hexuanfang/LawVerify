import { randomUUID } from 'node:crypto'

import type { AuthenticatedActor } from './commercial/types.js'
import { AppError } from './core/app-error.js'
import { readDevStore, updateDevStore } from './infrastructure/dev-store.js'
import type { InvoiceProfile, InvoiceRequest } from './types.js'

function formatCurrency(amountFen: number) {
  return `¥${(amountFen / 100).toFixed(2)}`
}

export async function listInvoiceProfiles(actor: AuthenticatedActor) {
  const store = await readDevStore()
  const organization = store.organizations.find((item) => item.id === actor.organizationId && item.status === 'active')
  const user = store.users.find((item) => item.id === actor.userId && item.status === 'active')

  if (!organization || !user) {
    throw new AppError('当前账户不存在。', 404, 'ACCOUNT_NOT_FOUND')
  }

  const items: InvoiceProfile[] = [
    {
      id: `invoice-profile-${organization.id}`,
      title: organization.name,
      taxNo: '',
      type: 'enterprise',
      isDefault: true,
    },
  ]

  if (organization.name !== user.name) {
    items.push({
      id: `invoice-profile-${user.id}`,
      title: user.name,
      taxNo: '',
      type: 'personal',
      isDefault: false,
    })
  }

  return {
    items,
  }
}

export async function listInvoiceRequests(actor: AuthenticatedActor, limit = 100) {
  const store = await readDevStore()
  const items = store.invoiceRequests
    .filter((item) => item.organizationId === actor.organizationId && item.userId === actor.userId)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit)
    .map<InvoiceRequest>(({ id, orderId, title, taxNo, registeredAddress, registeredPhone, bankName, bankAccount, recipientEmail, amountLabel, status }) => ({
      id,
      orderId,
      title,
      taxNo,
      registeredAddress,
      registeredPhone,
      bankName,
      bankAccount,
      recipientEmail,
      amountLabel,
      status,
    }))

  return { items }
}

export async function createInvoiceRequest(
  actor: AuthenticatedActor,
  input?: {
    orderId?: string
    title?: string
    taxNo?: string
    registeredAddress?: string
    registeredPhone?: string
    bankName?: string
    bankAccount?: string
    recipientEmail?: string
  },
) {
  return updateDevStore((store) => {
    const organization = store.organizations.find((item) => item.id === actor.organizationId && item.status === 'active')
    const user = store.users.find((item) => item.id === actor.userId && item.status === 'active')

    if (!organization || !user) {
      throw new AppError('当前账户不存在。', 404, 'ACCOUNT_NOT_FOUND')
    }

    const paidOrders = store.paymentOrders
      .filter((item) => item.organizationId === actor.organizationId && item.userId === actor.userId && item.status === 'paid')
      .sort((left, right) => new Date(right.paidAt || right.createdAt).getTime() - new Date(left.paidAt || left.createdAt).getTime())

    if (!paidOrders.length) {
      throw new AppError('暂无可开票的已支付订单，请先完成支付。', 400, 'INVOICE_ORDER_REQUIRED')
    }

    const targetOrder = input?.orderId
      ? paidOrders.find((item) => item.id === input.orderId || item.orderNo === input.orderId)
      : paidOrders[0]

    if (!targetOrder) {
      throw new AppError('未找到对应的已支付订单。', 404, 'INVOICE_ORDER_NOT_FOUND')
    }

    const existing = store.invoiceRequests.find((item) => item.organizationId === actor.organizationId && item.userId === actor.userId && item.orderId === targetOrder.orderNo)
    if (existing) {
      throw new AppError('该订单已提交过开票申请。', 409, 'INVOICE_REQUEST_EXISTS')
    }

    const nextRequest = {
      id: `invoice-${randomUUID()}`,
      organizationId: actor.organizationId,
      userId: actor.userId,
      orderId: targetOrder.orderNo,
      title: input?.title?.trim() || organization.name,
      taxNo: input?.taxNo?.trim() || '',
      registeredAddress: input?.registeredAddress?.trim() || '',
      registeredPhone: input?.registeredPhone?.trim() || '',
      bankName: input?.bankName?.trim() || '',
      bankAccount: input?.bankAccount?.trim() || '',
      recipientEmail: input?.recipientEmail?.trim() || '',
      amountLabel: formatCurrency(targetOrder.amountFen),
      status: 'submitted' as const,
      createdAt: new Date().toISOString(),
    }

    store.invoiceRequests.unshift(nextRequest)

    return {
      request: {
        id: nextRequest.id,
        orderId: nextRequest.orderId,
        title: nextRequest.title,
        taxNo: nextRequest.taxNo,
        registeredAddress: nextRequest.registeredAddress,
        registeredPhone: nextRequest.registeredPhone,
        bankName: nextRequest.bankName,
        bankAccount: nextRequest.bankAccount,
        recipientEmail: nextRequest.recipientEmail,
        amountLabel: nextRequest.amountLabel,
        status: nextRequest.status,
      },
    }
  })
}
