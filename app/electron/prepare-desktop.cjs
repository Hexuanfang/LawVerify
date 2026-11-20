const fs = require('node:fs')
const path = require('node:path')
const { prepareDefaultLawLibrary } = require('./prepare-default-law-library.cjs')
const { loadReleaseEndpoints } = require('./release-endpoints.cjs')
const { prepareParserResources } = require('./parser-resources.cjs')

const appRoot = path.resolve(__dirname, '..')
const serverRoot = path.resolve(appRoot, '..', 'server')
const desktopRoot = path.join(appRoot, '.desktop')
const serverDistSource = path.join(serverRoot, 'dist')
const migrationsSource = path.join(serverRoot, 'migrations')
const desktopServerRoot = path.join(desktopRoot, 'server')
const desktopServerEnvTarget = path.join(desktopServerRoot, '.env.local')

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
  const { loginBaseUrl } = loadReleaseEndpoints()
  ensureExists(serverDistSource, '服务端构建目录')

  fs.rmSync(desktopRoot, { recursive: true, force: true })
  fs.mkdirSync(desktopServerRoot, { recursive: true })
  copyDirectory(serverDistSource, path.join(desktopServerRoot, 'dist'))
  prepareParserResources(serverRoot, path.join(desktopRoot, 'parser'), {
    arch: process.platform === 'win32' ? 'x64' : undefined,
  })

  if (fs.existsSync(migrationsSource)) {
    copyDirectory(migrationsSource, path.join(desktopServerRoot, 'migrations'))
  }

  // Never copy development credentials into distributable desktop assets.
  // 桌面端启用调试埋点：构建完成后在 .desktop/server/.env.local 中取消
  // DEBUG_EVENT_URL 的注释并重启客户端；保持注释则不发送任何调试请求。
  fs.writeFileSync(desktopServerEnvTarget, [
    'KNOWLEDGE_RAG_MODE=local', 'AI_GATEWAY_MODE=cloud', 'LLM_TIMEOUT_MS=120000',
    'EMBEDDING_DIMENSION=1024', `CLOUD_API_BASE_URL=${loginBaseUrl}`,
    '# Debug event endpoint; leave empty to disable debug reporting.', '# DEBUG_EVENT_URL=http://127.0.0.1:7777/event', '',
  ].join('\n'), 'utf8')

  await prepareDefaultLawLibrary()

  console.log(`Prepared desktop assets at ${desktopRoot}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
