import { createApp, initializeCommercialInfrastructure } from './app.js'
import { config } from './config.js'
import { reconcileAiRequests } from './ai-request-store.js'

async function main() {
  await initializeCommercialInfrastructure()
  if (config.AI_GATEWAY_ENABLED) await reconcileAiRequests()
  const reconciliation = setInterval(() => {
    if (config.AI_GATEWAY_ENABLED) void reconcileAiRequests().catch(error => console.error('AI reconciliation failed:', error instanceof Error ? error.message : 'Unknown error'))
  }, 60000)
  reconciliation.unref()
  const app = createApp()

  app.listen(config.CLOUD_PORT, config.CLOUD_HOST, () => {
    console.log(`${config.CLOUD_APP_NAME} listening on http://${config.CLOUD_HOST}:${config.CLOUD_PORT}`)
  })
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
