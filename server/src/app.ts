import compression from 'compression'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import path from 'node:path'
import { env } from './config/env.js'
import { getFrontendDistDir, getStorageRoot } from './config/paths.js'
import { runMigrations } from './infrastructure/migrations.js'
import { createCollaboraProxy } from './integrations/collabora-proxy.js'
import { isDatabaseEnabled } from './infrastructure/postgres.js'
import { errorHandler, notFound } from './middleware/error-handler.js'
import { requestContext } from './middleware/request-context.js'
import { createLegacyRouter } from './routes/legacy.js'
import { createV1Router } from './routes/v1.js'

// 流式响应统一心跳：长时间没有新数据时补一个注释行，
// 让客户端知道连接还活着，不会把空闲当成断开。
// 只对已经在写数据的流式响应生效，普通请求不受影响。
export function streamHeartbeat(intervalMs = 15000) {
  return (_request: express.Request, response: express.Response, next: express.NextFunction) => {
    const originalWrite = response.write.bind(response)
    let timer: ReturnType<typeof setTimeout> | undefined

    const clear = () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    const arm = () => {
      clear()
      timer = setTimeout(() => {
        timer = undefined
        if (response.writableEnded || response.destroyed) return
        originalWrite(': heartbeat\n\n')
        response.flush?.()
        arm()
      }, intervalMs)
    }

    response.on('finish', clear)
    response.on('close', clear)
    response.write = ((chunk: unknown, ...rest: unknown[]) => {
      arm()
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof response.write
    next()
  }
}

function buildCorsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
  if (!origin || env.corsOrigins.includes(origin)) {
    callback(null, true)
    return
  }

  callback(new Error('当前来源未被允许访问'))
}

export function createApp() {
  const app = express()
  const frontendDist = getFrontendDistDir()
  const hasFrontendDist = existsSync(frontendDist)
  const collaboraProxy = createCollaboraProxy({
    publicPath: env.COLLABORA_PROXY_PATH,
    target: env.COLLABORA_PROXY_TARGET,
  })

  app.disable('x-powered-by')
  // API 响应不生成 ETag：工作区等接口按 x-workspace-account 请求头区分账号，
  // 浏览器缓存校验命中后会拿到 304 空响应，前端无法将其当作工作区数据使用。
  app.disable('etag')
  app.use(requestContext)
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  )
  app.use(
    cors({
      origin: buildCorsOrigin,
      credentials: true,
    }),
  )
  app.use(compression())
  app.use(express.json({ limit: env.JSON_LIMIT }))
  app.use(streamHeartbeat())
  app.use(
    env.STORAGE_PUBLIC_BASE_URL,
    express.static(getStorageRoot()),
  )
  app.use(collaboraProxy.middleware)
  if (hasFrontendDist) {
    app.use(express.static(frontendDist))
  }

  // API 一律不走浏览器缓存，避免工作区快照被复用或串到其它账号。
  app.use(env.API_PREFIX, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.use(env.API_V1_PREFIX, createV1Router())
  app.use(env.API_PREFIX, createLegacyRouter())
  app.use((request, response, next) => {
    if (!hasFrontendDist || request.method !== 'GET') {
      next()
      return
    }

    if (
      request.path.startsWith(env.API_V1_PREFIX)
      || request.path.startsWith(env.API_PREFIX)
      || request.path.startsWith(env.STORAGE_PUBLIC_BASE_URL)
      || request.path.startsWith(env.COLLABORA_PROXY_PATH)
    ) {
      next()
      return
    }

    response.sendFile(path.join(frontendDist, 'index.html'))
  })
  app.use(notFound)
  app.use(errorHandler)

  return {
    app,
    attachUpgrade(server: Server) {
      collaboraProxy.attachUpgrade(server)
    },
  }
}

export async function initializeCommercialInfrastructure() {
  if (env.AUTO_RUN_MIGRATIONS && isDatabaseEnabled()) {
    await runMigrations()
  }
}
