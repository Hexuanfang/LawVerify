import path from 'node:path'
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

export function getStorageRoot() {
  return path.resolve(getAppDataRoot(), env.STORAGE_LOCAL_ROOT)
}

export function getFrontendDistDir() {
  return normalizeRoot(env.FRONTEND_DIST_DIR ?? path.join(getRuntimeRoot(), '..', 'app', 'dist'))
}

export function getMigrationsDir() {
  return normalizeRoot(env.MIGRATIONS_DIR ?? path.join(getRuntimeRoot(), 'migrations'))
}
