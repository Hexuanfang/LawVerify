import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { config } from './config.js'
import { AppError } from './core/app-error.js'
import type { AuthenticatedActor } from './commercial/types.js'

let signingKey: KeyObject | undefined
const lifetimeSeconds = 120

export function issueParserTicket(actor: AuthenticatedActor) {
  const configuredKey = config.PARSER_TICKET_PRIVATE_KEY
  if (!configuredKey) throw new AppError('云端解析尚未启用。', 503, 'PARSER_TICKET_DISABLED')
  signingKey ??= createPrivateKey({ key: Buffer.from(configuredKey, 'base64'), format: 'der', type: 'pkcs8' })
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new AppError('解析凭证签名配置无效。', 503, 'PARSER_TICKET_CONFIG')
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ v: 1, aud: 'lawverify:parse', sub: actor.userId,
    org: actor.organizationId, iat: now, exp: now + lifetimeSeconds })).toString('base64url')
  return { token: `${payload}.${sign(null, Buffer.from(payload), signingKey).toString('base64url')}`, expiresIn: lifetimeSeconds }
}
