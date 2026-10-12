import { Pool, type QueryResult, type QueryResultRow } from 'pg'
import { env } from '../config/env.js'
import { AppError } from '../core/app-error.js'

let pool: Pool | null = null

export function isDatabaseEnabled() {
  return Boolean(env.DATABASE_URL)
}

export function getPool() {
  if (!env.DATABASE_URL) {
    throw new AppError('尚未配置 DATABASE_URL，PostgreSQL 商用能力未启用。', 503, 'DATABASE_DISABLED')
  }

  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    })
  }

  return pool
}

export async function query<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(sql, params)
}
