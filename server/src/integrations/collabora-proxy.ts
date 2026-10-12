import type { RequestHandler } from 'express'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import httpProxy from 'http-proxy'

interface CollaboraProxyOptions {
  publicPath: string
  target: string
}

function normalizePublicPath(value: string) {
  const normalized = value.startsWith('/') ? value : `/${value}`
  return normalized.replace(/\/+$/, '') || '/collabora'
}

function shouldProxyPath(url: string | undefined, publicPath: string) {
  if (!url) {
    return false
  }

  const pathname = new URL(url, 'http://localhost').pathname
  return pathname === publicPath || pathname.startsWith(`${publicPath}/`)
}

function rewriteProxyPath(url: string | undefined, publicPath: string) {
  if (!url) {
    return '/'
  }

  const parsed = new URL(url, 'http://localhost')
  const rewrittenPath = parsed.pathname === publicPath ? publicPath : parsed.pathname
  return `${rewrittenPath}${parsed.search}`
}

export function createCollaboraProxy(options: CollaboraProxyOptions) {
  const publicPath = normalizePublicPath(options.publicPath)
  const proxy = httpProxy.createProxyServer({
    target: options.target,
    changeOrigin: false,
    secure: false,
    ws: true,
    xfwd: true,
  })

  function getForwardedHost(headers: Record<string, string | string[] | undefined>) {
    const host = headers['x-forwarded-host'] ?? headers.host
    return Array.isArray(host) ? host[0] : host
  }

  function getForwardedProto(headers: Record<string, string | string[] | undefined>) {
    const proto = headers['x-forwarded-proto']
    const value = Array.isArray(proto) ? proto[0] : (proto ?? 'http')
    return value.split(',')[0]?.trim() || 'http'
  }

  proxy.on('proxyReq', (proxyRequest, request) => {
    const host = getForwardedHost(request.headers)
    const proto = getForwardedProto(request.headers)

    if (host) {
      proxyRequest.setHeader('Host', host)
      proxyRequest.setHeader('X-Forwarded-Host', host)
    }

    proxyRequest.setHeader('X-Forwarded-Proto', proto)
  })

  proxy.on('proxyReqWs', (proxyRequest, request) => {
    const host = getForwardedHost(request.headers)
    const proto = getForwardedProto(request.headers)

    if (host) {
      proxyRequest.setHeader('Host', host)
      proxyRequest.setHeader('X-Forwarded-Host', host)
    }

    proxyRequest.setHeader('X-Forwarded-Proto', proto)
  })

  proxy.on('error', (error, _request, response) => {
    if (response && 'headersSent' in response && (response.headersSent || response.writableEnded)) {
      console.error('Collabora proxy upstream closed after response:', error.message)
      return
    }

    if (response && 'writeHead' in response) {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ message: 'Collabora 代理不可用。', detail: error.message }))
      return
    }

    console.error('Collabora proxy error:', error)
  })

  const middleware: RequestHandler = (request, response, next) => {
    if (!shouldProxyPath(request.originalUrl, publicPath)) {
      next()
      return
    }

    request.url = rewriteProxyPath(request.originalUrl, publicPath)
    proxy.web(request, response)
  }

  function attachUpgrade(server: Server) {
    server.on('upgrade', (request, socket: Socket, head) => {
      if (!shouldProxyPath(request.url, publicPath)) {
        return
      }

      request.url = rewriteProxyPath(request.url, publicPath)
      proxy.ws(request, socket, head)
    })
  }

  return {
    middleware,
    attachUpgrade,
  }
}
