const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

async function exportArtifacts({ root, version, arch }) {
  assert.ok(['all', 'arm64', 'x64'].includes(arch), 'Invalid architecture')
  const reports = []
  for (const chip of arch === 'all' ? ['arm64', 'x64'] : [arch]) {
    for (const extension of ['dmg', 'zip']) {
      const fileName = `LawVerify-Mac-${version}-${chip}-signed-only.${extension}`
      const file = path.join(root, fileName)
      assert.ok(fs.statSync(file).size > 0, `Missing ${fileName}`)
      const hash = createHash('sha256')
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
      const sha256 = hash.digest('hex')
      fs.writeFileSync(`${file}.sha256`, `${sha256}  ${fileName}\n`)
      reports.push({
        fileName, arch: chip, version, sha256,
        signed: true, notarized: false, verified: false,
        verificationSkipped: true, channel: 'test',
      })
    }
  }
  fs.writeFileSync(path.join(root, `build-report-${arch}.json`), JSON.stringify(reports, null, 2) + '\n')
  return reports
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const index = args.indexOf('--arch')
  exportArtifacts({
    root: path.resolve(__dirname, '..', 'release-mac-signed-only'),
    version: require('../package.json').version,
    arch: index >= 0 ? args[index + 1] : 'all',
  }).then(reports => {
    console.log(`Exported ${reports.length} signed-only artifacts with SHA256. Not notarized or validated.`)
  }).catch(error => { console.error(error); process.exit(1) })
}

module.exports = { exportArtifacts }
