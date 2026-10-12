import compression from 'compression'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'

import { config } from './config.js'
import { AppError } from './core/app-error.js'
import { sendSuccess } from './http.js'
import { runMigrations } from './infrastructure/migrations.js'
import { seedAdminAccount } from './commercial/auth-service.js'
import { isDatabaseEnabled } from './infrastructure/postgres.js'
import { accountRouter } from './routes/account.js'
import { billingRouter } from './routes/billing.js'
import { clientRouter } from './routes/client.js'
import { invoicesRouter } from './routes/invoices.js'
import { siteRouter } from './routes/site.js'
import { adminRouter } from './routes/admin.js'

export function createApp() {
  const app = express()
  const captureRawBody = (request: Request, _response: Response, buffer: Buffer) => {
    ;(request as Request & { rawBody?: string }).rawBody = buffer.toString('utf8')
  }

  app.use(helmet())
  app.use(compression())
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true)
        return
      }

      callback(new Error('当前来源未被允许访问'))
    },
    credentials: true,
  }))
  app.use(express.json({ limit: config.JSON_LIMIT, verify: captureRawBody }))
  app.use(express.urlencoded({ extended: false, verify: captureRawBody }))

  app.get('/health', (_request, response) => {
    sendSuccess(response, {
      status: 'ok',
      appName: config.CLOUD_APP_NAME,
      now: new Date().toISOString(),
    })
  })

  app.use('/api/web', siteRouter)
  app.use('/api/account', accountRouter)
  app.use('/api/billing', billingRouter)
  app.use('/api/invoices', invoicesRouter)
  app.use('/api/client', clientRouter)
  app.use('/api/admin', adminRouter)

  app.use((request, response) => {
    response.status(404).json({
      success: false,
      error: {
        message: `Route not found: ${request.method} ${request.path}`,
      },
    })
  })

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError
      ? error
      : new AppError(error instanceof Error ? error.message : 'Unexpected server error.', 500, 'INTERNAL_ERROR')
    response.status(appError.statusCode).json({
      success: false,
      error: {
        message: appError.message,
        code: appError.code,
      },
    })
  })

  return app
}

export async function initializeCommercialInfrastructure() {
  if (config.AUTO_RUN_MIGRATIONS && isDatabaseEnabled()) {
    await runMigrations()
  }
  await seedAdminAccount()
}
