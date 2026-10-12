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
  app.use(
    env.STORAGE_PUBLIC_BASE_URL,
    express.static(getStorageRoot()),
  )
  app.use(collaboraProxy.middleware)
  if (hasFrontendDist) {
    app.use(express.static(frontendDist))
  }

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
