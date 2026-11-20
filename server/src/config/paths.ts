import path from 'node:path'
import { createHash } from 'node:crypto'
import { env } from './env.js'

function normalizeRoot(input: string) {
  return path.resolve(input)
}

export function getRuntimeRoot() {
  return normalizeRoot(env.APP_RUNTIME_ROOT ?? process.cwd())
}

export function getAppDataRoot() {
  return normalizeRoot(env.APP_DATA_ROOT ?? process.cwd())
}

export function getWorkspaceDataDir() {
  return normalizeRoot(env.WORKSPACE_DATA_DIR ?? path.join(getAppDataRoot(), 'data'))
}

export function getOfficeStorageDirectory(account: string | null) {
  const owner = createHash('sha256').update(account ?? '__local__').digest('hex')
  return path.join('office', owner)
}

export function getParserStorageDirectory(account: string | null) {
  const owner = createHash('sha256').update(account ?? '__local__').digest('hex')
  return path.join('parsing', owner)
}

export function getStorageRoot() {
  return path.resolve(getAppDataRoot(), env.STORAGE_LOCAL_ROOT)
}

export function getFrontendDistDir() {
  return normalizeRoot(env.FRONTEND_DIST_DIR ?? path.join(getRuntimeRoot(), '..', 'app', 'dist'))
}

export function getMigrationsDir() {
  return normalizeRoot(env.MIGRATIONS_DIR ?? path.join(getRuntimeRoot(), 'migrations'))
}
