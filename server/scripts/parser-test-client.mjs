import { openAsBlob } from 'node:fs'
import path from 'node:path'

function endpoint(base, route, setting) {
  if (!base) throw new Error(`请设置 ${setting}`)
  const url = new URL(base)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.hash || url.search
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error(`${setting} 必须使用 HTTPS，回环测试可使用 HTTP`)
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}${route}`
  return url
}

export function createParserTestClient(settings = process.env) {
  const parser = endpoint(settings.PARSER_TEST_SERVICE_URL || settings.PARSER_SERVICE_URL, '/parse', 'PARSER_SERVICE_URL')
  const session = settings.PARSER_TEST_SESSION_TOKEN?.trim()
  const serviceToken = settings.PARSER_SERVICE_TOKEN?.trim()
  const issuer = session && endpoint(settings.CLOUD_API_BASE_URL, '/api/account/parser-ticket', 'CLOUD_API_BASE_URL')
  if (!issuer && !serviceToken) throw new Error('请设置 PARSER_TEST_SESSION_TOKEN 或 PARSER_SERVICE_TOKEN')

  async function request(fileName, body) {
    let token = serviceToken
    if (issuer) {
      const response = await fetch(issuer, { method: 'POST', headers: { Authorization: `Bearer ${session}` },
        redirect: 'error', signal: AbortSignal.timeout(15000) })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`获取解析凭证失败（HTTP ${response.status}）`)
      }
      token = (await response.json())?.data?.token
      if (typeof token !== 'string' || !/^[\w-]+\.[\w-]+$/.test(token) || token.length > 2041) {
        throw new Error('解析凭证格式无效')
      }
    }
    const url = new URL(parser)
    url.searchParams.set('fileName', fileName)
    return fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body, redirect: 'error', signal: AbortSignal.timeout(900000) })
  }

  async function parseFile(filePath) {
    const fileName = path.basename(filePath)
    const response = await request(fileName, await openAsBlob(filePath))
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`${fileName} 解析失败（HTTP ${response.status}）`)
    }
    const result = await response.json()
    if (result?.schemaVersion !== 1 || typeof result.text !== 'string' || !Array.isArray(result.blocks)) {
      throw new Error(`${fileName} 解析结果格式无效`)
    }
    return result
  }

  return { request, parseFile }
}
