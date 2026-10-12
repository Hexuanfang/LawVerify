import { createApp, initializeCommercialInfrastructure } from './app.js'
import { env } from './config/env.js'

const { app, attachUpgrade } = createApp()

// #region debug-point A:process-lifecycle
function reportDebug(hypothesisId: string, msg: string, data: Record<string, unknown> = {}) {
  void fetch('http://127.0.0.1:7777/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'backend-file-load',
      runId: 'pre-fix',
      hypothesisId,
      location: 'server/src/index.ts',
      msg: `[DEBUG] ${msg}`,
      data,
      ts: Date.now(),
    }),
  }).catch(() => {})
}

process.on('unhandledRejection', (reason) => {
  reportDebug('A', 'server-unhandled-rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  })
})

process.on('uncaughtException', (error) => {
  reportDebug('A', 'server-uncaught-exception', {
    message: error.message,
    stack: error.stack,
  })
})

process.on('exit', (code) => {
  reportDebug('A', 'server-process-exit', {
    code,
  })
})
// #endregion

async function main() {
  // #region debug-point A:start-main
  reportDebug('A', 'server-main-start', {
    port: env.PORT,
    apiPrefix: env.API_PREFIX,
    apiV1Prefix: env.API_V1_PREFIX,
  })
  // #endregion
  await initializeCommercialInfrastructure()

  const server = app.listen(env.PORT, () => {
    // #region debug-point A:listen-ready
    reportDebug('A', 'server-listen-ready', {
      port: env.PORT,
    })
    // #endregion
    console.log(`LawVerify server running on http://localhost:${env.PORT}`)
    console.log(`Legacy API: http://localhost:${env.PORT}${env.API_PREFIX}`)
    console.log(`Versioned API: http://localhost:${env.PORT}${env.API_V1_PREFIX}`)
  })

  attachUpgrade(server)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
