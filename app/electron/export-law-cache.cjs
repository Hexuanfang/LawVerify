const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const mammoth = require('mammoth')
const { getSourceFingerprint, normalizeText, chunkKnowledgeText, defaultLawSourceDir,
  cacheFilePath, outputFilePath } = require('./prepare-default-law-library.cjs')

async function main() {
  const seed = JSON.parse(fs.readFileSync(outputFilePath, 'utf8'))
  const sourceFingerprint = getSourceFingerprint()
  assert.ok(sourceFingerprint, 'No law source documents found')
  const names = fs.readdirSync(defaultLawSourceDir).filter((name) => /\.docx$/i.test(name))
  assert.equal(seed.knowledgeFiles.length, names.length, 'Cached law file count differs from the source')
  for (const name of names) {
    const item = seed.knowledgeFiles.find((file) => file.fileName === `法律文件/${name}`)
    assert.ok(item, `Missing cached source: ${name}`)
    const raw = await mammoth.extractRawText({ path: path.join(defaultLawSourceDir, name) })
    assert.equal(item.extractedText, normalizeText(raw.value), `Changed source: ${name}. Rebuild the seed first.`)
    const chunks = chunkKnowledgeText(item.extractedText)
    const cachedChunks = seed.localRagIndex.files[item.id]?.chunks
    assert.equal(cachedChunks?.length, chunks.length, `Missing embeddings: ${name}`)
    for (const [index, chunk] of cachedChunks.entries()) {
      assert.equal(chunk.content, chunks[index])
      assert.equal(chunk.embedding.length, 1024, 'Expected 1024-dimensional real embeddings')
      assert.ok(chunk.embedding.every(Number.isFinite) && chunk.embedding.some((value) => value !== 0))
    }
  }
  seed.sourceDir = '法律文件'
  seed.sourceFingerprint = sourceFingerprint
  fs.writeFileSync(cacheFilePath, JSON.stringify(seed))
  console.log(`Exported verified embeddings for ${names.length} law documents to ${cacheFilePath}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
