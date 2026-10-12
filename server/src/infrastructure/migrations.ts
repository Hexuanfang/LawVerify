import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getMigrationsDir } from '../config/paths.js'
import { query } from './postgres.js'

const migrationsDir = getMigrationsDir()

export async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      file_name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()

  for (const fileName of files) {
    const existing = await query<{ id: number }>(
      'SELECT id FROM schema_migrations WHERE file_name = $1 LIMIT 1',
      [fileName],
    )

    if (existing.rowCount) {
      continue
    }

    const fullPath = path.join(migrationsDir, fileName)
    const sql = await readFile(fullPath, 'utf8')
    await query(sql)
    await query('INSERT INTO schema_migrations (file_name) VALUES ($1)', [fileName])
  }
}
