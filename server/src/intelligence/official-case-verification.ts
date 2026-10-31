import { isOfficialCaseUrl, normalizeCaseNumber } from './legal-verification.js'

export async function checkOfficialJudgment(url: string, number: string, fetcher: typeof fetch = fetch) {
  if (!isOfficialCaseUrl(url)) return false
  const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: 'error' })
  if (!response.ok || !response.body) return false
  const reader = response.body.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 2_000_000) return false
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const text = Buffer.concat(chunks).toString('utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
  return normalizeCaseNumber(text).includes(normalizeCaseNumber(number))
    && /判决书|裁定书|裁判文书/.test(text)
}
