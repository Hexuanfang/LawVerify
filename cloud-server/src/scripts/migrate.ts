import { runMigrations } from '../infrastructure/migrations.js'
import { isDatabaseEnabled } from '../infrastructure/postgres.js'

async function main() {
  if (!isDatabaseEnabled()) {
    throw new Error('未配置 DATABASE_URL，无法执行 cloud-server 迁移。')
  }

  await runMigrations()
  console.log('cloud-server migrations applied successfully.')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
