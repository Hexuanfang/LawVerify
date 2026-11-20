const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')

function runtimeFileNeeded(root, source) {
  const relative = path.relative(root, source).replaceAll('\\', '/')
  const parts = relative.split('/')
  return !parts.some(part => ['__pycache__', 'test', 'tests', '.pytest_cache'].includes(part))
    && !/\.(pyc|pyo|pdb)$/i.test(source)
    && !/^(include|libs|Scripts)(\/|$)/.test(relative)
    && !/^Lib\/(idlelib|ensurepip|tkinter|turtledemo)(\/|$)/.test(relative)
}

function hashFile(file) {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(4 * 1024 ** 2)
  try {
    let length
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length))
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function normalizeArchiveTimes(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`解析资源不能包含符号链接：${entry.name}`)
    if (entry.isDirectory()) normalizeArchiveTimes(file)
    else fs.utimesSync(file, 0, 0)
  }
  fs.utimesSync(directory, 0, 0)
}

function normalizeGzipTime(file) {
  const descriptor = fs.openSync(file, 'r+')
  try {
    const header = Buffer.alloc(10)
    fs.readSync(descriptor, header, 0, header.length, 0)
    if (header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 8 || header[3] !== 0) {
      throw new Error('解析资源的 gzip 文件头格式不受支持。')
    }
    // gzip 时间字段不参与数据 CRC，置零后相同 tar 内容产生相同资源哈希。
    fs.writeSync(descriptor, Buffer.alloc(4), 0, 4, 4)
  } finally {
    fs.closeSync(descriptor)
  }
}

function prepareParserResources(serverRoot, targetRoot, options = {}) {
  const runtime = options.runtime || process.env.LAWVERIFY_PARSER_RUNTIME_SOURCE || path.resolve(serverRoot, '../tmp/parser-runtime')
  const modelHome = path.resolve(serverRoot, '../python-workers/mineru-home')
  const models = options.models || process.env.LAWVERIFY_PARSER_MODELS_SOURCE
    || (fs.existsSync(modelHome) ? modelHome : path.join(serverRoot, 'python', '.models'))
  const executable = process.platform === 'win32' ? 'python.exe' : 'bin/python3'
  if (!fs.existsSync(path.join(runtime, executable)) || fs.existsSync(path.join(runtime, 'pyvenv.cfg'))) {
    throw new Error('缺少可搬移的 Python 解析运行环境，请先运行 server/scripts/prepare-parser-runtime.py。')
  }
  if (!fs.existsSync(path.join(models, 'models', 'MinerU-4_models_onnx'))) {
    throw new Error('缺少 MinerU ONNX 模型，请准备对应平台的解析资源。')
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'lawverify-runtime.json'), 'utf8'))
  if (manifest.platform !== process.platform) throw new Error('Python 解析运行环境与构建平台不匹配。')
  const normalizedArch = value => ({ AMD64: 'x64', x86_64: 'x64', aarch64: 'arm64' }[value] || value)
  const targetArch = options.arch || process.env.LAWVERIFY_PARSER_TARGET_ARCH || process.arch
  if (normalizedArch(manifest.architecture) !== normalizedArch(targetArch)) throw new Error('Python 解析运行环境与目标架构不匹配，请按架构分别构建。')
  const workerRoot = path.resolve(serverRoot, '../python-workers')
  const legacySource = path.join(serverRoot, 'python')
  const sourceRoot = options.mode === 'download' && fs.existsSync(path.join(legacySource, 'worker.py')) ? legacySource : workerRoot
  fs.cpSync(sourceRoot, path.join(targetRoot, 'python'), {
    recursive: true, filter: source => source === sourceRoot || /\.(py|txt|md)$/.test(source),
  })
  if (options.mode !== 'download') {
    for (const name of ['http-worker-pool.mjs', 'desktop-resources.mjs', 'python-workers.ts']) {
      fs.copyFileSync(path.join(workerRoot, name), path.join(targetRoot, 'python', name))
    }
  }
  fs.cpSync(runtime, path.join(targetRoot, 'python-runtime'), {
    recursive: true, verbatimSymlinks: true, filter: source => runtimeFileNeeded(runtime, source),
  })
  fs.cpSync(models, path.join(targetRoot, 'mineru-home'), {
    recursive: true, filter: source => !['.cache', '__pycache__', '.derived', '.locks'].includes(path.basename(source)),
  })
  if (options.mode !== 'download') return
  if (process.platform !== 'win32') throw new Error('按需解析资源当前仅用于 Windows。')
  const output = options.outputDirectory || path.join(serverRoot, '..', 'app', process.env.LAWVERIFY_BUILDER_OUTPUT_DIR || 'release', 'parser-resources')
  fs.mkdirSync(output, { recursive: true })
  const temporary = path.join(output, `.parser-${randomUUID()}.tar.gz`)
  try {
    console.log('正在压缩独立解析资源…')
    // 固定复制品的时间戳，使仅更新应用时仍能复用同一份解析资源。
    for (const name of ['python-runtime', 'mineru-home']) normalizeArchiveTimes(path.join(targetRoot, name))
    execFileSync('tar.exe', ['-czf', temporary, '-C', targetRoot, 'python-runtime', 'mineru-home'], {
      windowsHide: true, stdio: 'pipe', timeout: 30 * 60 * 1000,
    })
    normalizeGzipTime(temporary)
    const sha256 = hashFile(temporary)
    const size = fs.statSync(temporary).size
    const destination = path.join(output, `${sha256}.tar.gz`)
    if (fs.existsSync(destination)) fs.rmSync(temporary)
    else fs.renameSync(temporary, destination)
    const baseUrl = (options.baseUrl || 'https://lawverify.zhijing.fun').replace(/\/$/, '')
    fs.writeFileSync(path.join(targetRoot, 'parser-resource.json'), JSON.stringify({
      schemaVersion: 1, platform: 'win32', arch: normalizedArch(targetArch),
      engineVersion: manifest.engineVersion, sha256, size,
      url: `${baseUrl}/api/web/parser-resources/${sha256}.tar.gz`,
    }, null, 2))
    // 安装包只带固定清单，完整环境从独立资源包安装到用户数据目录。
    for (const name of ['python-runtime', 'mineru-home']) fs.rmSync(path.join(targetRoot, name), { recursive: true, force: true })
    console.log(`解析资源包：${destination} (${(size / 1024 ** 2).toFixed(2)} MB)`)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

module.exports = { prepareParserResources }
