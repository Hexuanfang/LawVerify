const { pathToFileURL } = require('node:url')
const path = require('node:path')

let server
function diagnostic(event, error) {
  // Never send exception messages, case text, credentials or filesystem paths.
  process.parentPort?.postMessage({ type: 'diagnostic', event, code: typeof error?.code === 'string' ? error.code : undefined })
}
function fatal(event, error) {
  diagnostic(event, error)
  process.exit(1)
}

process.on('uncaughtException', error => fatal('service-uncaught-exception', error))
process.on('unhandledRejection', error => fatal('service-unhandled-rejection', error))
process.parentPort?.on('message', ({ data }) => {
  if (data?.type === 'ping') {
    process.parentPort.postMessage({ type: 'pong', rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024) })
  }
  if (data?.type === 'stop') {
    server?.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
})

async function main() {
  const backendEntry = path.join(process.env.APP_RUNTIME_ROOT, 'dist', 'app.js')
  const backend = await import(pathToFileURL(backendEntry).href)
  await backend.initializeCommercialInfrastructure()
  const bootstrap = backend.createApp()
  server = await new Promise((resolve, reject) => {
    const instance = bootstrap.app.listen(Number(process.env.PORT), '127.0.0.1', () => resolve(instance))
    instance.once('error', reject)
  })
  bootstrap.attachUpgrade(server)
  process.parentPort?.postMessage({ type: 'ready' })
}

void main().catch(error => fatal('service-start-failed', error))
