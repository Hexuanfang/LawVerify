const fs = require('node:fs')
const path = require('node:path')
const { prepareDefaultLawLibrary } = require('./prepare-default-law-library.cjs')

const appRoot = path.resolve(__dirname, '..')
const serverRoot = path.resolve(appRoot, '..', 'server')
const desktopRoot = path.join(appRoot, '.desktop')
const serverDistSource = path.join(serverRoot, 'dist')
const migrationsSource = path.join(serverRoot, 'migrations')
const serverEnvSource = path.join(serverRoot, '.env.local')
const desktopServerRoot = path.join(desktopRoot, 'server')
const desktopServerEnvTarget = path.join(desktopServerRoot, '.env.local')
const OFFICIAL_PLATFORM_BASE_URL = 'https://lawagent.zhijing.fun'
const desktopRuntimeEnvKeys = [
  'KNOWLEDGE_RAG_MODE',
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_TIMEOUT_MS',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIMENSION',
  'EMBEDDING_BATCH_SIZE',
  'EMBEDDING_TIMEOUT_MS',
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'QDRANT_COLLECTION_KNOWLEDGE',
  'QDRANT_TIMEOUT_MS',
  'YUANDIAN_API_KEY',
  'YUANDIAN_CASE_SEARCH_TOOL',
  'YUANDIAN_MCP_URL',
  'WK_API_KEY',
  'WK_CASE_SEARCH_TOOL',
  'WK_MCP_URL',
  'PKULAW_API_KEY',
  'PKULAW_CASE_SEARCH_TOOL',
  'PKULAW_MCP_URL',
  'CLOUD_API_BASE_URL',
]

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} 不存在：${targetPath}`)
  }
}

function copyDirectory(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, force: true })
}

function writeRuntimeEnvFile(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return
  }

  const entries = []

  for (const rawLine of fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1)
    if (!desktopRuntimeEnvKeys.includes(key) || !value.trim()) {
      continue
    }

    entries.push(`${key}=${value}`)
  }

  if (!entries.length) {
    return
  }

  fs.writeFileSync(targetPath, `${entries.join('\n')}\n`, 'utf8')
}

async function main() {
  ensureExists(serverDistSource, '服务端构建目录')

  fs.rmSync(desktopRoot, { recursive: true, force: true })
  fs.mkdirSync(desktopServerRoot, { recursive: true })
  copyDirectory(serverDistSource, path.join(desktopServerRoot, 'dist'))

  if (fs.existsSync(migrationsSource)) {
    copyDirectory(migrationsSource, path.join(desktopServerRoot, 'migrations'))
  }

  writeRuntimeEnvFile(serverEnvSource, desktopServerEnvTarget)

  const existingEnv = fs.existsSync(desktopServerEnvTarget)
    ? fs.readFileSync(desktopServerEnvTarget, 'utf8')
    : ''
  const nextEnvLines = existingEnv
    .split(/\r?\n/)
    .filter((line) => !(line.trim().startsWith('CLOUD_API_BASE_URL=')))
    .concat([`CLOUD_API_BASE_URL=${OFFICIAL_PLATFORM_BASE_URL}`])
    .filter(Boolean)
  fs.writeFileSync(desktopServerEnvTarget, `${nextEnvLines.join('\n')}\n`, 'utf8')

  await prepareDefaultLawLibrary()

  console.log(`Prepared desktop assets at ${desktopRoot}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
