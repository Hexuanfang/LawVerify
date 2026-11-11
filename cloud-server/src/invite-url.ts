import { config } from './config.js'

/**
 * 邀请链接的统一生成规则：官网注册页 + ?invite=邀请码。
 */
export function buildInviteUrl(code: string) {
  return `${config.CLOUD_PUBLIC_BASE_URL.replace(/\/$/, '')}/register?invite=${code}`
}
