import { createRequire } from 'node:module'

import { config } from '../config.js'
import { AppError } from '../core/app-error.js'

const require = createRequire(import.meta.url)
const sms = require('@alicloud/dysmsapi20170525') as typeof import('@alicloud/dysmsapi20170525')
const openApi = require('@alicloud/openapi-core') as typeof import('@alicloud/openapi-core')
const credentials = require('@alicloud/credentials') as typeof import('@alicloud/credentials')

export async function sendVerificationSms(phone: string, code: string) {
  try {
    const client = new sms.default(new openApi.$OpenApiUtil.Config({
      credential: new credentials.default(),
      endpoint: 'dysmsapi.aliyuncs.com',
      connectTimeout: 5_000,
      readTimeout: 10_000,
    }))
    const { body } = await client.sendSms(new sms.SendSmsRequest({
      phoneNumbers: phone,
      signName: config.ALIYUN_SMS_SIGN_NAME,
      templateCode: config.ALIYUN_SMS_TEMPLATE_CODE,
      templateParam: JSON.stringify({ code }),
    }))
    if (body?.code === 'OK') return
  } catch {
    // SDK 错误对象可能包含原请求，避免将手机号和验证码写入日志。
  }
  throw new AppError('短信发送暂不可用，请稍后重试。', 502, 'SMS_SEND_FAILED')
}
