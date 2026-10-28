import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline } from 'node:stream'

const hopByHopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function forwardHeaders(headers) {
  const excluded = new Set(hopByHopHeaders)
  for (const name of String(headers.connection || '').split(',')) {
    excluded.add(name.trim().toLowerCase())
  }
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
    value != null && !excluded.has(name.toLowerCase()) && name.toLowerCase() !== 'host'))
}

export function proxyApiRequest(request, response, apiBase, headerTimeoutMs = 300_000) {
  const target = new URL(`${apiBase}${request.url}`)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = send(target, {
    method: request.method,
    headers: forwardHeaders(request.headers),
  })

  function fail(error) {
    clearTimeout(headerTimer)
    if (response.destroyed || response.writableEnded) return
    if (response.headersSent) {
      // Never turn an interrupted installer into a successfully completed download.
      response.destroy(error)
      return
    }
    response.writeHead(502, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end('Service temporarily unavailable. Please retry.')
  }

  const headerTimer = setTimeout(() => {
    upstream.destroy(new Error('Upstream response timeout'))
  }, headerTimeoutMs)
  headerTimer.unref()

  upstream.on('error', fail)
  request.on('aborted', () => upstream.destroy())
  request.on('error', (error) => upstream.destroy(error))
  response.on('close', () => {
    clearTimeout(headerTimer)
    if (!response.writableFinished) upstream.destroy()
  })

  upstream.on('response', (incoming) => {
    clearTimeout(headerTimer)
    response.writeHead(incoming.statusCode || 502, forwardHeaders(incoming.headers))
    response.flushHeaders()
    // Native HTTP preserves the exact encoded bytes, length, and Range headers.
    pipeline(incoming, response, (error) => {
      if (error) {
        upstream.destroy()
        fail(error)
      }
    })
  })
  request.pipe(upstream)
}
