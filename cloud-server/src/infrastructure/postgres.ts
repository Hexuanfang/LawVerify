import { Pool, type QueryResult, type QueryResultRow } from 'pg'

import { config } from '../config.js'
import { AppError } from '../core/app-error.js'

let pool: Pool | null = null

export function isDatabaseEnabled() {
  return Boolean(config.DATABASE_URL?.trim())
}

export function getPool() {
  if (!isDatabaseEnabled()) {
    throw new AppError('尚未配置 DATABASE_URL，cloud-server 数据库能力未启用。', 503, 'DATABASE_DISABLED')
  }

  if (!pool) {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
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
