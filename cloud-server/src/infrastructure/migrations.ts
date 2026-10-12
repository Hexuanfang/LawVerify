import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { config } from '../config.js'
import { query } from './postgres.js'

function getMigrationsDir() {
  return config.MIGRATIONS_DIR
    ? path.resolve(config.MIGRATIONS_DIR)
    : path.join(config.cloudServerRoot, 'migrations')
}

export async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      file_name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const migrationsDir = getMigrationsDir()
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()

  for (const fileName of files) {
    const existing = await query<{ id: number }>(
      'SELECT id FROM schema_migrations WHERE file_name = $1 LIMIT 1',
      [fileName],
    )

    if (existing.rowCount) {
      continue
    }

    const sql = await readFile(path.join(migrationsDir, fileName), 'utf8')
    await query(sql)
    await query('INSERT INTO schema_migrations (file_name) VALUES ($1)', [fileName])
  }
}
