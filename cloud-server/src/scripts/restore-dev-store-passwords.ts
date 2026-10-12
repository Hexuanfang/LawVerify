import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { config } from '../config.js'
import { getPool, isDatabaseEnabled } from '../infrastructure/postgres.js'

type DevStoreUser = {
  email: string
  passwordHash?: string | null
}

type DevStoreShape = {
  users: DevStoreUser[]
}

function getDevStorePath() {
  return path.join(config.cloudServerRoot, '.data', 'dev-store.json')
}

async function loadDevStore() {
  const content = await readFile(getDevStorePath(), 'utf8')
  return JSON.parse(content) as DevStoreShape
}

async function main() {
  if (!isDatabaseEnabled()) {
    throw new Error('未配置 DATABASE_URL，无法恢复用户密码。')
  }

  const store = await loadDevStore()
  const storeUsers = new Map(
    store.users
      .filter((user) => user.email && user.passwordHash)
      .map((user) => [user.email.trim().toLowerCase(), user.passwordHash!.trim()]),
  )

  const pool = getPool()
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const currentUsersResult = await client.query<{
      id: string
      email: string
      password_hash: string | null
    }>('SELECT id, email, password_hash FROM users ORDER BY email ASC')

    let updatedUsers = 0
    let matchedUsers = 0

    for (const user of currentUsersResult.rows) {
      const normalizedEmail = user.email.trim().toLowerCase()
      const historicalHash = storeUsers.get(normalizedEmail)
      if (!historicalHash) {
        continue
      }

      matchedUsers += 1
      if (user.password_hash === historicalHash) {
        continue
      }

      await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
        historicalHash,
        user.id,
      ])
      updatedUsers += 1
    }

    await client.query('COMMIT')
    console.log(
      JSON.stringify(
        {
          totalHistoricalUsers: storeUsers.size,
          matchedUsers,
          updatedUsers,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
