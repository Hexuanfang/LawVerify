import { createDecipheriv, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes } from 'node:crypto'

import { config } from '../config.js'
import { AppError } from '../core/app-error.js'
import type { BillingProvider, PaymentChannel, PaymentOrderStatus } from '../types.js'

type CreateRechargeGatewayOrderInput = {
  outTradeNo: string
  title: string
  description: string
  amountFen: number
}

type CreatedGatewayOrder = {
  providerOrderId?: string
  qrCodeContent: string
  paymentUrl?: string
  providerMessage?: string
  expiresAt?: string
}

type QueriedGatewayOrder = {
  status: PaymentOrderStatus
  providerOrderId?: string
  providerMessage?: string
  paidAt?: string
}

function normalizePemBlock(value: string | undefined, label: 'PRIVATE KEY' | 'PUBLIC KEY') {
  const text = value?.trim()
  if (!text) {
    return ''
  }

  const normalized = text.replace(/\\n/g, '\n').trim()
  if (normalized.includes('BEGIN')) {
    return normalized
  }

  const wrapped = normalized.match(/.{1,64}/g)?.join('\n') ?? normalized
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`
}

function ensureHttpsUrl(value: string | undefined) {
  const text = value?.trim()
  if (!text) {
    return ''
  }

  try {
    const parsed = new URL(text)
    return parsed.protocol === 'https:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function formatFenToYuan(amountFen: number) {
  return (amountFen / 100).toFixed(2)
}

function createNonce(size = 16) {
  return randomBytes(size).toString('hex')
}

function signWithPrivateKey(content: string, privateKeyPem: string) {
  const signer = createSign('RSA-SHA256')
  signer.update(content, 'utf8')
  signer.end()
  return signer.sign(createPrivateKey(privateKeyPem), 'base64')
}

function verifyWithPublicKey(content: string, signature: string, publicKeyPem: string) {
  const verifier = createVerify('RSA-SHA256')
  verifier.update(content, 'utf8')
  verifier.end()
  return verifier.verify(createPublicKey(publicKeyPem), signature, 'base64')
}

function alipayConfigured() {
  return Boolean(
    config.ALIPAY_APP_ID?.trim()
    && normalizePemBlock(config.ALIPAY_PRIVATE_KEY, 'PRIVATE KEY')
    && normalizePemBlock(config.ALIPAY_PUBLIC_KEY, 'PUBLIC KEY'),
  )
}

function wechatConfigured() {
  return Boolean(
    config.WECHAT_PAY_APP_ID?.trim()
    && config.WECHAT_PAY_MCH_ID?.trim()
    && config.WECHAT_PAY_SERIAL_NO?.trim()
    && normalizePemBlock(config.WECHAT_PAY_PRIVATE_KEY, 'PRIVATE KEY')
    && config.WECHAT_PAY_NOTIFY_URL?.trim()
    && config.WECHAT_PAY_API_V3_KEY?.trim().length === 32,
  )
}

function wechatCallbackVerificationConfigured() {
  return Boolean(
    config.WECHAT_PAY_PLATFORM_PUBLIC_KEY?.trim(),
  )
}

export function isDevPaymentSimulationEnabled() {
  return config.DEV_PAYMENT_SIMULATION
}

export function verifyAlipayCallbackSignature(payload: Record<string, unknown>) {
  const publicKey = normalizePemBlock(config.ALIPAY_PUBLIC_KEY, 'PUBLIC KEY')
  const signature = typeof payload.sign === 'string' ? payload.sign.trim() : ''
  if (!publicKey || !signature) {
    throw new AppError('支付宝回调验签参数未配置完整。', 400, 'ALIPAY_SIGNATURE_NOT_CONFIGURED')
  }

  const signContent = Object.keys(payload)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .sort()
    .map((key) => {
      const value = payload[key]
      return value === undefined || value === null ? '' : `${key}=${String(value)}`
    })
    .filter(Boolean)
    .join('&')

  return verifyWithPublicKey(signContent, signature, publicKey)
}

export function verifyWechatCallbackSignature(input: {
  timestamp?: string
  nonce?: string
  signature?: string
  serial?: string
  rawBody: string
}) {
  const publicKey = normalizePemBlock(config.WECHAT_PAY_PLATFORM_PUBLIC_KEY, 'PUBLIC KEY')
  const expectedSerial = config.WECHAT_PAY_PLATFORM_SERIAL_NO?.trim()
  if (!publicKey || !input.timestamp?.trim() || !input.nonce?.trim() || !input.signature?.trim()) {
    throw new AppError('微信支付回调验签参数未配置完整。', 400, 'WECHAT_SIGNATURE_NOT_CONFIGURED')
  }

  if (expectedSerial && input.serial?.trim() && expectedSerial !== input.serial.trim()) {
    throw new AppError('微信支付平台证书序列号不匹配。', 400, 'WECHAT_SIGNATURE_SERIAL_MISMATCH')
  }

  const message = `${input.timestamp.trim()}\n${input.nonce.trim()}\n${input.rawBody}\n`
  return verifyWithPublicKey(message, input.signature.trim(), publicKey)
}

export function shouldVerifyGatewayCallback(provider: PaymentChannel) {
  if (provider === 'alipay') {
    return Boolean(normalizePemBlock(config.ALIPAY_PUBLIC_KEY, 'PUBLIC KEY'))
  }

  return wechatCallbackVerificationConfigured()
}

export function getPaymentProviderStatuses(): BillingProvider[] {
  const devSimulationEnabled = isDevPaymentSimulationEnabled()
  return [
    {
      id: 'alipay',
      label: '支付宝',
      enabled: alipayConfigured() || devSimulationEnabled,
      reason: alipayConfigured()
        ? undefined
        : devSimulationEnabled
          ? '开发环境模拟支付已启用。'
          : '支付宝支付参数未配置完整。',
    },
    {
      id: 'wechat',
      label: '微信支付',
      enabled: wechatConfigured() || devSimulationEnabled,
      reason: wechatConfigured()
        ? undefined
        : devSimulationEnabled
          ? '开发环境模拟支付已启用。'
          : '微信支付参数未配置完整，且微信 Native 需配置可访问的 HTTPS 通知地址。',
    },
  ]
}

function createDevelopmentGatewayOrder(channel: PaymentChannel, input: CreateRechargeGatewayOrderInput): CreatedGatewayOrder {
  const paymentUrl = new URL('/console/billing', config.CLOUD_PUBLIC_BASE_URL)
  paymentUrl.searchParams.set('orderNo', input.outTradeNo)
  return {
    providerOrderId: `dev-${channel}-${input.outTradeNo}`,
    qrCodeContent: paymentUrl.toString(),
    paymentUrl: paymentUrl.toString(),
    providerMessage: '开发环境模拟支付，需手动点击完成支付。',
    expiresAt: new Date(Date.now() + 1000 * 60 * 30).toISOString(),
  }
}

function buildAlipaySignedParams(method: string, bizContent: Record<string, unknown>) {
  const privateKey = normalizePemBlock(config.ALIPAY_PRIVATE_KEY, 'PRIVATE KEY')
  if (!config.ALIPAY_APP_ID?.trim() || !privateKey) {
    throw new AppError('支付宝支付参数未配置完整。', 400, 'ALIPAY_NOT_CONFIGURED')
  }

  const params: Record<string, string> = {
    app_id: config.ALIPAY_APP_ID.trim(),
    method,
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  }

  const notifyUrl = ensureHttpsUrl(config.ALIPAY_NOTIFY_URL)
  if (notifyUrl) {
    params.notify_url = notifyUrl
  }

  const signContent = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')

  params.sign = signWithPrivateKey(signContent, privateKey)
  return params
}

async function postAlipay(method: string, bizContent: Record<string, unknown>) {
  const params = buildAlipaySignedParams(method, bizContent)
  const body = new URLSearchParams(params)
  const response = await fetch(config.ALIPAY_GATEWAY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body,
  })

  if (!response.ok) {
    throw new AppError(`支付宝网关请求失败：${response.status}`, 502, 'ALIPAY_GATEWAY_ERROR')
  }

  return response.json() as Promise<Record<string, unknown>>
}

async function createAlipayRechargeOrder(input: CreateRechargeGatewayOrderInput): Promise<CreatedGatewayOrder> {
  const payload = await postAlipay('alipay.trade.precreate', {
    out_trade_no: input.outTradeNo,
    total_amount: formatFenToYuan(input.amountFen),
    subject: input.title,
    body: input.description,
  })

  const response = payload.alipay_trade_precreate_response as Record<string, unknown> | undefined
  if (!response) {
    throw new AppError('支付宝返回数据异常。', 502, 'ALIPAY_INVALID_RESPONSE')
  }

  const code = typeof response.code === 'string' ? response.code : ''
  if (code !== '10000') {
    const message = typeof response.sub_msg === 'string'
      ? response.sub_msg
      : typeof response.msg === 'string'
        ? response.msg
        : '支付宝预下单失败。'
    throw new AppError(message, 502, 'ALIPAY_PRECREATE_FAILED')
  }

  const qrCodeContent = typeof response.qr_code === 'string' ? response.qr_code.trim() : ''
  if (!qrCodeContent) {
    throw new AppError('支付宝未返回扫码地址。', 502, 'ALIPAY_QR_MISSING')
  }

  return {
    providerOrderId: typeof response.out_trade_no === 'string' ? response.out_trade_no : input.outTradeNo,
    qrCodeContent,
    paymentUrl: qrCodeContent,
    providerMessage: typeof response.msg === 'string' ? response.msg : '等待支付',
  }
}

async function queryAlipayRechargeOrder(outTradeNo: string): Promise<QueriedGatewayOrder> {
  const payload = await postAlipay('alipay.trade.query', {
    out_trade_no: outTradeNo,
  })

  const response = payload.alipay_trade_query_response as Record<string, unknown> | undefined
  if (!response) {
    throw new AppError('支付宝查询返回异常。', 502, 'ALIPAY_QUERY_INVALID_RESPONSE')
  }

  const code = typeof response.code === 'string' ? response.code : ''
  if (code !== '10000' && code !== '40004') {
    const message = typeof response.sub_msg === 'string'
      ? response.sub_msg
      : typeof response.msg === 'string'
        ? response.msg
        : '支付宝订单查询失败。'
    throw new AppError(message, 502, 'ALIPAY_QUERY_FAILED')
  }

  const tradeStatus = typeof response.trade_status === 'string' ? response.trade_status : ''
  if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
    return {
      status: 'paid',
      providerOrderId: typeof response.trade_no === 'string' ? response.trade_no : undefined,
      providerMessage: tradeStatus,
      paidAt: typeof response.send_pay_date === 'string'
        ? new Date(response.send_pay_date.replace(' ', 'T')).toISOString()
        : new Date().toISOString(),
    }
  }

  if (tradeStatus === 'WAIT_BUYER_PAY' || code === '40004') {
    return {
      status: 'pending',
      providerOrderId: typeof response.trade_no === 'string' ? response.trade_no : undefined,
      providerMessage: tradeStatus || 'WAIT_BUYER_PAY',
    }
  }

  if (tradeStatus === 'TRADE_CLOSED') {
    return {
      status: 'closed',
      providerOrderId: typeof response.trade_no === 'string' ? response.trade_no : undefined,
      providerMessage: tradeStatus,
    }
  }

  return {
    status: 'failed',
    providerOrderId: typeof response.trade_no === 'string' ? response.trade_no : undefined,
    providerMessage: tradeStatus || 'UNKNOWN',
  }
}

function buildWechatAuthorization(method: 'POST' | 'GET', requestPath: string, body: string) {
  const mchId = config.WECHAT_PAY_MCH_ID?.trim()
  const serialNo = config.WECHAT_PAY_SERIAL_NO?.trim()
  const privateKey = normalizePemBlock(config.WECHAT_PAY_PRIVATE_KEY, 'PRIVATE KEY')

  if (!mchId || !serialNo || !privateKey) {
    throw new AppError('微信支付参数未配置完整。', 400, 'WECHAT_PAY_NOT_CONFIGURED')
  }

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = createNonce()
  const message = `${method}\n${requestPath}\n${timestamp}\n${nonce}\n${body}\n`
  const signature = signWithPrivateKey(message, privateKey)

  return {
    authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`,
  }
}

async function callWechatApi<T>(method: 'POST' | 'GET', requestPath: string, body?: Record<string, unknown>) {
  const requestBody = method === 'POST' ? JSON.stringify(body ?? {}) : ''
  const { authorization } = buildWechatAuthorization(method, requestPath, requestBody)
  const response = await fetch(`${config.WECHAT_PAY_API_BASE}${requestPath}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'User-Agent': 'LawVerify/cloud-server',
    },
    body: method === 'POST' ? requestBody : undefined,
  })

  const text = await response.text()
  if (!response.ok) {
    throw new AppError(text || `微信支付网关请求失败：${response.status}`, 502, 'WECHAT_GATEWAY_ERROR')
  }

  return (text ? JSON.parse(text) : {}) as T
}

async function createWechatRechargeOrder(input: CreateRechargeGatewayOrderInput): Promise<CreatedGatewayOrder> {
  const appId = config.WECHAT_PAY_APP_ID?.trim()
  const mchId = config.WECHAT_PAY_MCH_ID?.trim()
  const notifyUrl = ensureHttpsUrl(config.WECHAT_PAY_NOTIFY_URL)

  if (!appId || !mchId || !notifyUrl) {
    throw new AppError('微信支付参数未配置完整，需提供可访问的 HTTPS 通知地址。', 400, 'WECHAT_PAY_NOT_CONFIGURED')
  }

  const payload = await callWechatApi<{
    code_url?: string
    prepay_id?: string
  }>('POST', '/v3/pay/transactions/native', {
    appid: appId,
    mchid: mchId,
    description: input.description,
    out_trade_no: input.outTradeNo,
    notify_url: notifyUrl,
    time_expire: new Date(Date.now() + 1000 * 60 * 30).toISOString(),
    amount: {
      total: input.amountFen,
      currency: 'CNY',
    },
  })

  if (!payload.code_url?.trim()) {
    throw new AppError('微信支付未返回扫码地址。', 502, 'WECHAT_QR_MISSING')
  }

  return {
    providerOrderId: payload.prepay_id?.trim(),
    qrCodeContent: payload.code_url.trim(),
    paymentUrl: payload.code_url.trim(),
    providerMessage: '等待支付',
  }
}

async function queryWechatRechargeOrder(outTradeNo: string): Promise<QueriedGatewayOrder> {
  const mchId = config.WECHAT_PAY_MCH_ID?.trim()
  if (!mchId) {
    throw new AppError('微信支付参数未配置完整。', 400, 'WECHAT_PAY_NOT_CONFIGURED')
  }

  const requestPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(mchId)}`
  const payload = await callWechatApi<{
    transaction_id?: string
    trade_state?: string
    success_time?: string
  }>('GET', requestPath)

  const tradeState = payload.trade_state?.trim() || ''
  if (tradeState === 'SUCCESS') {
    return {
      status: 'paid',
      providerOrderId: payload.transaction_id?.trim(),
      providerMessage: tradeState,
      paidAt: payload.success_time?.trim() || new Date().toISOString(),
    }
  }

  if (tradeState === 'NOTPAY' || !tradeState) {
    return {
      status: 'pending',
      providerOrderId: payload.transaction_id?.trim(),
      providerMessage: tradeState || 'NOTPAY',
    }
  }

  if (tradeState === 'CLOSED' || tradeState === 'REVOKED') {
    return {
      status: 'closed',
      providerOrderId: payload.transaction_id?.trim(),
      providerMessage: tradeState,
    }
  }

  return {
    status: 'failed',
    providerOrderId: payload.transaction_id?.trim(),
    providerMessage: tradeState || 'PAYERROR',
  }
}

export async function createGatewayRechargeOrder(
  channel: PaymentChannel,
  input: CreateRechargeGatewayOrderInput,
) {
  if (!alipayConfigured() && channel === 'alipay' && isDevPaymentSimulationEnabled()) {
    return createDevelopmentGatewayOrder(channel, input)
  }

  if (!wechatConfigured() && channel === 'wechat' && isDevPaymentSimulationEnabled()) {
    return createDevelopmentGatewayOrder(channel, input)
  }

  if (channel === 'alipay') {
    return createAlipayRechargeOrder(input)
  }

  return createWechatRechargeOrder(input)
}

export async function queryGatewayRechargeOrder(
  channel: PaymentChannel,
  outTradeNo: string,
) {
  if (channel === 'alipay' && !alipayConfigured() && isDevPaymentSimulationEnabled()) {
    return {
      status: 'pending' as const,
      providerOrderId: `dev-alipay-${outTradeNo}`,
      providerMessage: '开发环境模拟支付待完成',
    }
  }

  if (channel === 'wechat' && !wechatConfigured() && isDevPaymentSimulationEnabled()) {
    return {
      status: 'pending' as const,
      providerOrderId: `dev-wechat-${outTradeNo}`,
      providerMessage: '开发环境模拟支付待完成',
    }
  }

  if (channel === 'alipay') {
    return queryAlipayRechargeOrder(outTradeNo)
  }

  return queryWechatRechargeOrder(outTradeNo)
}

export function decryptWechatNotificationResource(resource: {
  associated_data?: string
  nonce: string
  ciphertext: string
}) {
  const apiV3Key = config.WECHAT_PAY_API_V3_KEY?.trim()
  if (!apiV3Key || apiV3Key.length !== 32) {
    throw new AppError('微信支付 APIv3 Key 未配置完整。', 400, 'WECHAT_PAY_NOT_CONFIGURED')
  }

  const cipherBuffer = Buffer.from(resource.ciphertext, 'base64')
  const authTag = cipherBuffer.subarray(cipherBuffer.length - 16)
  const encrypted = cipherBuffer.subarray(0, cipherBuffer.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(resource.nonce, 'utf8'))

  if (resource.associated_data) {
    decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'))
  }
  decipher.setAuthTag(authTag)

  const decoded = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8')

  return JSON.parse(decoded) as {
    out_trade_no?: string
    transaction_id?: string
    trade_state?: string
    success_time?: string
  }
}
