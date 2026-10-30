import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { proxyApiRequest } from './api-proxy.mjs'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const distRoot = path.join(currentDir, 'dist')

function getArgValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && index < process.argv.length - 1) {
    return process.argv[index + 1]
  }

  return ''
}

const host = getArgValue('--host') || process.env.PREVIEW_HOST || '0.0.0.0'
const port = Number(getArgValue('--port') || process.env.PREVIEW_PORT || '4273')
const apiBase = (getArgValue('--api-base') || process.env.PREVIEW_API_BASE || 'http://127.0.0.1:8788').replace(/\/$/, '')

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
  })
  response.end(message)
}

function normalizeRequestPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0] || '/')
  const normalized = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, '')
  return normalized.startsWith(path.sep) ? normalized.slice(1) : normalized
}

async function serveStaticAsset(requestPath, response) {
  const relativePath = normalizeRequestPath(requestPath)
  const candidatePath = path.join(distRoot, relativePath)
  const hasFileExtension = path.extname(relativePath) !== ''

  if (existsSync(candidatePath)) {
    const fileStat = await stat(candidatePath)
    if (fileStat.isFile()) {
      response.writeHead(200, {
        'Content-Type': mimeTypes.get(path.extname(candidatePath)) || 'application/octet-stream',
        'Content-Length': fileStat.size,
      })
      createReadStream(candidatePath).pipe(response)
      return
    }
  }

  if (hasFileExtension) {
    sendText(response, 404, 'Not Found')
    return
  }

  const indexPath = path.join(distRoot, 'index.html')
  const html = await readFile(indexPath)
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
  })
  response.end(html)
}

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      sendText(response, 400, 'Bad Request')
      return
    }

    if (request.url.startsWith('/api/')) {
      proxyApiRequest(request, response, apiBase)
      return
    }

    await serveStaticAsset(request.url, response)
  } catch (error) {
    console.error('Web request failed:', error)
    if (response.headersSent) {
      response.destroy()
    } else {
      sendText(response, 500, 'Service temporarily unavailable. Please retry.')
    }
  }
})

server.listen(port, host, () => {
  console.log(`Web preview server listening on http://${host}:${port}`)
  console.log(`Proxying /api/* to ${apiBase}`)
})
