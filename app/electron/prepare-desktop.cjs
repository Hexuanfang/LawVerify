const fs = require('node:fs')
const path = require('node:path')
const { prepareDefaultLawLibrary } = require('./prepare-default-law-library.cjs')

const appRoot = path.resolve(__dirname, '..')
const serverRoot = path.resolve(appRoot, '..', 'server')
const desktopRoot = path.join(appRoot, '.desktop')
const serverDistSource = path.join(serverRoot, 'dist')
const migrationsSource = path.join(serverRoot, 'migrations')
const desktopServerRoot = path.join(desktopRoot, 'server')
const desktopServerEnvTarget = path.join(desktopServerRoot, '.env.local')
const OFFICIAL_PLATFORM_BASE_URL = 'https://lawagent.zhijing.fun'

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} 不存在：${targetPath}`)
  }
}

function copyDirectory(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, force: true })
}


async function main() {
  ensureExists(serverDistSource, '服务端构建目录')

  fs.rmSync(desktopRoot, { recursive: true, force: true })
  fs.mkdirSync(desktopServerRoot, { recursive: true })
  copyDirectory(serverDistSource, path.join(desktopServerRoot, 'dist'))

  if (fs.existsSync(migrationsSource)) {
    copyDirectory(migrationsSource, path.join(desktopServerRoot, 'migrations'))
  }

  // Never copy development credentials into distributable desktop assets.
  fs.writeFileSync(desktopServerEnvTarget, [
    'KNOWLEDGE_RAG_MODE=local', 'AI_GATEWAY_MODE=cloud', 'LLM_TIMEOUT_MS=120000',
    'EMBEDDING_DIMENSION=1024', `CLOUD_API_BASE_URL=${OFFICIAL_PLATFORM_BASE_URL}`, '',
  ].join('\n'), 'utf8')

  await prepareDefaultLawLibrary()

  console.log(`Prepared desktop assets at ${desktopRoot}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
