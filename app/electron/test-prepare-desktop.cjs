const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const vm = require('node:vm')

const project = path.resolve(__dirname, '../..')

test('桌面服务启动时不从用户目录读取旧的解析凭据文件', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  const start = source.indexOf('function applyDesktopServerEnv(port)')
  const end = source.indexOf('async function startPackagedServer()', start)
  const env = {}
  const userData = path.join(project, 'tmp/parser-config-fixture')
  vm.runInNewContext(source.slice(start, end) + '\napplyDesktopServerEnv(18787)', {
    app: { getPath: () => userData }, path, __dirname, process: { env, resourcesPath: userData }, isDev: true,
    fs: {
      existsSync: location => location === path.join(userData, 'parser.env'),
      readFileSync: () => 'PARSER_SERVICE_TOKEN=fixture-only-token\nNODE_OPTIONS=unexpected\n',
    },
    require,
  })
  assert.equal(env.PARSER_SERVICE_TOKEN, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.PORT, '18787')
  assert.equal(env.PARSER_BUNDLE_ROOT, path.join(userData, 'parser'))
})

function fixture(endpoints = { loginBaseUrl: 'https://lawverify.zhijing.fun' }) {
  const root = fs.mkdtempSync(path.join(project, 'tmp/local-desktop-package-'))
  const electron = path.join(root, 'app/electron')
  const worker = path.join(root, 'python-workers')
  const runtime = path.join(root, 'tmp/parser-runtime')
  const executable = path.join(runtime, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  fs.mkdirSync(electron, { recursive: true })
  fs.mkdirSync(path.join(worker, 'mineru-home/models/MinerU-4_models_onnx'), { recursive: true })
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, 'fixture')
  fs.writeFileSync(path.join(runtime, 'lawverify-runtime.json'), JSON.stringify({ platform: process.platform,
    architecture: process.platform === 'win32' ? 'x64' : process.arch }))
  for (const name of ['worker.py', 'http-worker-pool.mjs', 'desktop-resources.mjs', 'python-workers.ts']) {
    fs.writeFileSync(path.join(worker, name), 'fixture')
  }
  fs.mkdirSync(path.join(root, 'server/dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'server/dist/app.js'), 'export const fixture = true')
  fs.copyFileSync(path.join(__dirname, 'prepare-desktop.cjs'), path.join(electron, 'prepare-desktop.cjs'))
  fs.copyFileSync(path.join(__dirname, 'account-network.cjs'), path.join(electron, 'account-network.cjs'))
  fs.copyFileSync(path.join(__dirname, 'release-endpoints.cjs'), path.join(electron, 'release-endpoints.cjs'))
  fs.copyFileSync(path.join(__dirname, 'parser-resources.cjs'), path.join(electron, 'parser-resources.cjs'))
  fs.writeFileSync(path.join(electron, 'release-endpoints.json'), JSON.stringify(endpoints))
  fs.writeFileSync(path.join(electron, 'prepare-default-law-library.cjs'), 'module.exports.prepareDefaultLawLibrary = async () => {}')
  return root
}

test('桌面构建内置 Python、模型和解析进程池', () => {
  const root = fixture()
  const target = path.join(root, 'app/.desktop/server')
  fs.mkdirSync(path.join(target, 'python-runtime'), { recursive: true })
  fs.writeFileSync(path.join(target, 'parser-resource.json'), 'old manifest')
  const result = spawnSync(process.execPath, [path.join(root, 'app/electron/prepare-desktop.cjs')], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, LAWVERIFY_PARSER_RUNTIME_SOURCE: '', LAWVERIFY_PARSER_MODELS_SOURCE: '',
      LAWVERIFY_PARSER_SERVICE_URL: 'https://parser.example.com/api/' },
  })
  assert.equal(result.status, 0, result.stderr)
  const config = fs.readFileSync(path.join(target, '.env.local'), 'utf8')
  assert.doesNotMatch(config, /^PARSER_(SERVICE|TICKET)/m)
  assert.ok(fs.existsSync(path.join(target, 'dist/app.js')))
  for (const name of ['python', 'python-runtime', 'mineru-home', 'parser-resource.json']) {
    assert.ok(!fs.existsSync(path.join(target, name)), name)
  }
  const resources = path.join(root, 'app/.desktop/parser')
  for (const name of ['python/worker.py', 'python/http-worker-pool.mjs', 'python/desktop-resources.mjs', 'python/python-workers.ts',
    'python-runtime/lawverify-runtime.json', 'mineru-home/models/MinerU-4_models_onnx']) {
    assert.ok(fs.existsSync(path.join(resources, name)), name)
  }
  assert.ok(!fs.existsSync(path.join(root, 'app/release/parser-resources')))
  assert.ok(!config.includes('PARSER_SERVICE_TOKEN'))
})

test('构建拒绝公网明文及携带凭据的登录地址，并保留已有准备目录', () => {
  for (const loginBaseUrl of ['http://login.example.com', 'https://user:secret@login.example.com']) {
    const root = fixture({ loginBaseUrl })
    const sentinel = path.join(root, 'app/.desktop/sentinel')
    fs.mkdirSync(path.dirname(sentinel), { recursive: true })
    fs.writeFileSync(sentinel, 'preserved')
    const result = spawnSync(process.execPath, [path.join(root, 'app/electron/prepare-desktop.cjs')], {
      encoding: 'utf8', windowsHide: true,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /登录地址/)
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserved')
  }
})

test('登录仍使用发布配置，桌面构建忽略开发环境中的解析凭据', async () => {
  const root = fixture({ loginBaseUrl: 'https://login.example.com/' })
  fs.writeFileSync(path.join(root, 'server/.env.local'), 'CLOUD_API_BASE_URL=https://dev.example.com\nPARSER_SERVICE_TOKEN=fixture-only-token\n')
  const env = { ...process.env, LAWVERIFY_PARSER_RUNTIME_SOURCE: '', LAWVERIFY_PARSER_MODELS_SOURCE: '' }
  const result = spawnSync(process.execPath, [path.join(root, 'app/electron/prepare-desktop.cjs')], {
    encoding: 'utf8', windowsHide: true, env,
  })
  assert.equal(result.status, 0, result.stderr)
  const config = fs.readFileSync(path.join(root, 'app/.desktop/server/.env.local'), 'utf8')
  assert.match(config, /^CLOUD_API_BASE_URL=https:\/\/login\.example\.com$/m)
  assert.doesNotMatch(config, /^PARSER_(SERVICE|TICKET)/m)
  assert.doesNotMatch(config, /dev\.example\.com|fixture-only-token/)

  const { createAccountRequestHandler } = require(path.join(root, 'app/electron/account-network.cjs'))
  let sentUrl
  const request = createAccountRequestHandler({
    isTrustedSender: () => true,
    fetch: async url => {
      sentUrl = url
      return new Response('{}')
    },
  })
  const response = await request({}, { path: '/api/account/login', method: 'POST' })
  assert.equal(response.status, 200)
  assert.equal(sentUrl, 'https://login.example.com/api/account/login')
})

test('Windows 与 Mac 均将 Python 原生资源放在 asar 外', () => {
  const { build } = require('../package.json')
  const mac = require('./mac-builder.cjs')
  for (const config of [build, mac]) {
    assert.deepEqual(config.extraResources, [{ from: '.desktop/parser', to: 'parser' }])
    assert.ok(config.files.includes('.desktop/server/**/*'))
    assert.ok(!config.files.includes('.desktop/**/*'))
  }
})
