import { createPublicKey, timingSafeEqual, verify } from 'node:crypto'

export function createParserAuthenticator({ token, publicKey }) {
  if (publicKey) {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('解析验签需要 Ed25519 公钥')
    return authorization => {
      if (!authorization?.startsWith('Bearer ') || authorization.length > 2048) return null
      const parts = authorization.slice(7).split('.')
      if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null
      const [payload, signature] = parts
      const bytes = Buffer.from(signature, 'base64url')
      if (bytes.length !== 64 || !verify(null, Buffer.from(payload), key, bytes)) return null
      try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        const now = Math.floor(Date.now() / 1000)
        if (!claims || claims.v !== 1 || claims.aud !== 'lawverify:parse'
          || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128
          || typeof claims.org !== 'string' || !claims.org || claims.org.length > 128
          || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
          || claims.iat > now + 5 || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 120) return null
        return { userId: claims.sub, organizationId: claims.org }
      } catch { return null }
    }
  }

  if (!token) throw new Error('必须配置解析验签公钥或本机测试凭据')
  const expected = Buffer.from(`Bearer ${token}`)
  return authorization => {
    const provided = Buffer.from(authorization || '')
    return provided.length === expected.length && timingSafeEqual(provided, expected) ? {} : null
  }
}
