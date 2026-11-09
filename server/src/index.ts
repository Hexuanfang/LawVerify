import { createApp, initializeCommercialInfrastructure } from './app.js'
import { env } from './config/env.js'
import { clearUploadTempFiles } from './middleware/bounded-upload.js'

const { app, attachUpgrade } = createApp()

// #region debug-point A:process-lifecycle
// 启用方式：设置环境变量 DEBUG_EVENT_URL=http://127.0.0.1:7777/event 后重启服务；未设置则不发送任何调试请求。
function reportDebug(hypothesisId: string, msg: string, data: Record<string, unknown> = {}) {
  const debugEventUrl = env.DEBUG_EVENT_URL?.trim()
  if (!debugEventUrl) {
    return
  }

  void fetch(debugEventUrl, {
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
  await initializeCommercialInfrastructure()
  // 上传中断留下的临时文件在启动时清空，避免大文件残留持续占用磁盘。
  await clearUploadTempFiles()

  const server = app.listen(env.PORT, env.SERVER_HOST, () => {
    // #region debug-point A:listen-ready
    reportDebug('A', 'server-listen-ready', {
      port: env.PORT,
      host: env.SERVER_HOST,
    })
    // #endregion
    console.log(`LawVerify server running on http://${env.SERVER_HOST}:${env.PORT}`)
    console.log(`Legacy API: http://localhost:${env.PORT}${env.API_PREFIX}`)
    console.log(`Versioned API: http://localhost:${env.PORT}${env.API_V1_PREFIX}`)
  })

  attachUpgrade(server)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
