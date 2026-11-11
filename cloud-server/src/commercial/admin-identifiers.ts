import { z } from 'zod'
import { config } from '../config.js'

/**
 * 平台管理员标识的统一口径：
 * - config.ADMIN_EMAILS 里配置的所有标识（如 admin、972167580@qq.com）；
 * - 注册、登录、后台鉴权都复用这里，避免各处重复解析导致口径不一致。
 */
export function getPlatformAdminEmails() {
  return config.ADMIN_EMAILS
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

export function isPlatformAdminEmail(email: string | undefined | null) {
  const normalized = email?.trim().toLowerCase() ?? ''
  return Boolean(normalized) && getPlatformAdminEmails().includes(normalized)
}

/**
 * 注册邮箱的放行规则：合法邮箱，或管理员标识（admin 及 ADMIN_EMAILS 中配置的账号）。
 */
export function isAllowedRegistrationEmail(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return false
  }
  if (normalized === 'admin' || isPlatformAdminEmail(normalized)) {
    return true
  }
  return z.email().safeParse(normalized).success
}
