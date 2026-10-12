const fs = require('node:fs')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')
const serverRoot = path.resolve(appRoot, '..', 'server')
const desktopRoot = path.join(appRoot, '.desktop')
const serverDistSource = path.join(serverRoot, 'dist')
const migrationsSource = path.join(serverRoot, 'migrations')
const desktopServerRoot = path.join(desktopRoot, 'server')

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} 不存在：${targetPath}`)
  }
}

function copyDirectory(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, force: true })
}

function main() {
  ensureExists(serverDistSource, '服务端构建目录')

  fs.rmSync(desktopRoot, { recursive: true, force: true })
  fs.mkdirSync(desktopServerRoot, { recursive: true })
  copyDirectory(serverDistSource, path.join(desktopServerRoot, 'dist'))

  if (fs.existsSync(migrationsSource)) {
    copyDirectory(migrationsSource, path.join(desktopServerRoot, 'migrations'))
  }

  console.log(`Prepared desktop assets at ${desktopRoot}`)
}

main()
