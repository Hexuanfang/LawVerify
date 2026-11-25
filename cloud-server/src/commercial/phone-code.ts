import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'

import { config } from '../config.js'
import { AppError } from '../core/app-error.js'
import { isDatabaseEnabled, query, withTransaction } from '../infrastructure/postgres.js'
import { sendVerificationSms } from '../integrations/aliyun-sms.js'

export type PhoneCodePurpose = 'register' | 'login'

export type PhoneCodeInput = {
  phone: string
  challengeId: string
  code: string
}

const resendSeconds = 60
const expiresInSeconds = 300

function getOtpSecret() {
  if (!isDatabaseEnabled() || !config.ALIYUN_SMS_SIGN_NAME ||
      !/^SMS_\d+$/.test(config.ALIYUN_SMS_TEMPLATE_CODE ?? '') ||
      !config.SMS_OTP_SECRET || config.SMS_OTP_SECRET.length < 32) {
    throw new AppError('当前环境未启用手机号认证。', 503, 'SMS_AUTH_UNAVAILABLE')
  }
  return config.SMS_OTP_SECRET
}

function digest(secret: string, ...values: string[]) {
  return createHmac('sha256', secret).update(JSON.stringify(values)).digest('hex')
}

export async function sendPhoneCode(phone: string, purpose: PhoneCodePurpose, ip: string) {
  const secret = getOtpSecret()
  const challengeId = randomUUID()
  const code = String(randomInt(100_000, 1_000_000))
  const phoneKey = digest(secret, 'phone', phone)
  const ipKey = digest(secret, 'ip', ip.replace(/^::ffff:/, ''))
  const codeDigest = digest(secret, 'code', challengeId, phone, purpose, code)

  await withTransaction(async client => {
    // ponytail: 平台发送额度共用一把事务锁，发送请求在事务提交后发出，高吞吐时再拆分计数。
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lawverify-account-sms-send', 0))")
    await client.query("DELETE FROM account_sms_challenges WHERE created_at < NOW() - INTERVAL '1 day'")
    const { rows: [limits] } = await client.query<{ cooldown: boolean; limited: boolean }>(`
      SELECT COALESCE(bool_or(phone_key = $1 AND created_at > NOW() - make_interval(secs => $3)), false) AS cooldown,
        (count(*) FILTER (WHERE phone_key = $1) >= 5 OR count(*) FILTER (WHERE ip_key = $2) >= 20
          OR count(*) >= 120) AS limited
      FROM account_sms_challenges WHERE created_at > NOW() - INTERVAL '1 hour'
    `, [phoneKey, ipKey, resendSeconds])
    if (limits.cooldown || limits.limited) {
      throw new AppError(limits.cooldown ? '请等待 60 秒再发送验证码。' : '验证码请求次数过多，请稍后重试。',
        429, 'SMS_RATE_LIMIT')
    }
    await client.query(`INSERT INTO account_sms_challenges (id, phone_key, ip_key, purpose, code_digest)
      VALUES ($1, $2, $3, $4, $5)`, [challengeId, phoneKey, ipKey, purpose, codeDigest])
  })

  await sendVerificationSms(phone, code)
  await query('UPDATE account_sms_challenges SET sent_at = NOW() WHERE id = $1', [challengeId])
  return { challengeId, retryAfterSeconds: resendSeconds, expiresInSeconds }
}

export async function withVerifiedPhoneCode<T>(input: PhoneCodeInput, purpose: PhoneCodePurpose,
  operation: (client: PoolClient) => Promise<T>) {
  const secret = getOtpSecret()
  const phoneKey = digest(secret, 'phone', input.phone)
  const expected = digest(secret, 'code', input.challengeId, input.phone, purpose, input.code)
  const result = await withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [phoneKey])
    const { rows: [challenge] } = await client.query<{ code_digest: string }>(`
      SELECT code_digest FROM account_sms_challenges WHERE id = $1 AND phone_key = $2 AND purpose = $3
        AND sent_at > clock_timestamp() - make_interval(secs => $4) AND consumed_at IS NULL AND attempts < 5
      FOR UPDATE
    `, [input.challengeId, phoneKey, purpose, expiresInSeconds])
    if (!challenge) return null
    const matched = timingSafeEqual(Buffer.from(challenge.code_digest, 'hex'), Buffer.from(expected, 'hex'))
    if (!matched) {
      await client.query('UPDATE account_sms_challenges SET attempts = attempts + 1 WHERE id = $1', [input.challengeId])
      return null
    }
    const value = await operation(client)
    await client.query(`UPDATE account_sms_challenges SET consumed_at = NOW()
      WHERE phone_key = $1 AND purpose = $2 AND sent_at IS NOT NULL AND consumed_at IS NULL`, [phoneKey, purpose])
    return { value }
  })
  if (!result) throw new AppError('验证码错误、已失效或尝试次数已用完，请重新获取。', 400, 'INVALID_SMS_CODE')
  return result.value
}
