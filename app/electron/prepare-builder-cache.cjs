const fs = require('node:fs')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')
const vendorRoot = path.join(appRoot, 'build', 'vendor', 'electron-builder')
const cacheRoot = path.join(appRoot, '.cache', 'electron-builder')
const cacheEntries = ['7zip@1.0.0', 'nsis-3.0.4.1', 'nsis-resources-3.4.1']

function ensureVendorEntry(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`缺少桌面构建缓存资源：${sourcePath}`)
  }
}

function copyTreeIfMissing(sourcePath, destinationPath, copied) {
  const sourceStat = fs.statSync(sourcePath)

  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true })
    for (const entry of fs.readdirSync(sourcePath)) {
      copyTreeIfMissing(path.join(sourcePath, entry), path.join(destinationPath, entry), copied)
    }
    return
  }

  if (fs.existsSync(destinationPath)) {
    return
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  fs.copyFileSync(sourcePath, destinationPath)
  copied.push(path.relative(cacheRoot, destinationPath))
}

function main() {
  const copied = []

  for (const entry of cacheEntries) {
    const sourcePath = path.join(vendorRoot, entry)
    const destinationPath = path.join(cacheRoot, entry)
    ensureVendorEntry(sourcePath)
    copyTreeIfMissing(sourcePath, destinationPath, copied)
  }

  if (copied.length === 0) {
    console.log(`Desktop builder cache already ready at ${cacheRoot}`)
    return
  }

  console.log(`Prepared desktop builder cache at ${cacheRoot}: ${copied.join(', ')}`)
}

main()
