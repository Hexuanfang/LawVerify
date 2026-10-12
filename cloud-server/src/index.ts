import { createApp, initializeCommercialInfrastructure } from './app.js'
import { config } from './config.js'

async function main() {
  await initializeCommercialInfrastructure()
  const app = createApp()

  app.listen(config.CLOUD_PORT, config.CLOUD_HOST, () => {
    console.log(`${config.CLOUD_APP_NAME} listening on http://${config.CLOUD_HOST}:${config.CLOUD_PORT}`)
  })
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
