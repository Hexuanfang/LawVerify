import { createApp, initializeCommercialInfrastructure } from './app.js'
import { env } from './config/env.js'

const { app, attachUpgrade } = createApp()

async function main() {
  await initializeCommercialInfrastructure()

  const server = app.listen(env.PORT, () => {
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
