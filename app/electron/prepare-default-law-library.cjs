const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const mammoth = require('mammoth')

const appRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(appRoot, '..')
const serverRoot = path.join(projectRoot, 'server')
const desktopRoot = path.join(appRoot, '.desktop')
const desktopSeedRoot = path.join(desktopRoot, 'server', 'seeds')
const defaultLawSourceDir = path.join(projectRoot, 'files', '法律文件')
const outputFilePath = path.join(desktopSeedRoot, 'default-law-library.json')
const articleNumberPattern = /^((第[一二三四五六七八九十百千万零〇两0-9]+条))\s*(.*)$/u

function createStableId(prefix, seed) {
  const digest = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12)
  return `${prefix}-${digest}`
}

function normalizeText(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function summarizeKnowledgeText(text) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function chunkKnowledgeText(text, chunkSize = 480) {
  const source = text.replace(/\r/g, '').trim()
  if (!source) {
    return []
  }

  const paragraphs = source
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean)

  if (!paragraphs.length) {
    return [source]
  }

  const chunks = []
  let current = ''

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph
      continue
    }

    if (`${current}\n\n${paragraph}`.length <= chunkSize) {
      current = `${current}\n\n${paragraph}`
      continue
    }

    chunks.push(current)
    current = paragraph
  }

  if (current) {
    chunks.push(current)
  }

  return chunks
}

function uniqueStrings(items, limit = Number.POSITIVE_INFINITY) {
  const result = []
  for (const item of items) {
    const normalized = `${item ?? ''}`.trim()
    if (!normalized || result.includes(normalized)) {
      continue
    }

    result.push(normalized)
    if (result.length >= limit) {
      break
    }
  }

  return result
}

function buildKnowledgeVectorKeywords(title, text) {
  const matches = `${title}\n${text}`.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,20}/g) ?? []
  return uniqueStrings(matches.filter((item) => !/^\d+$/.test(item)), 18)
}

function inferIssuer(title) {
  if (title.includes('宪法') || title.includes('民法典')) {
    return '全国人民代表大会'
  }

  if (title.startsWith('中华人民共和国')) {
    return '全国人民代表大会常务委员会'
  }

  return '国家法律法规数据库'
}

function inferEffectiveStatus() {
  return 'effective'
}

function inferDocType() {
  return '法律'
}

function toIsoDateFromFileName(fileName, fallbackIso) {
  const matched = fileName.match(/_(\d{8})(?=\.docx$)/i)
  if (!matched) {
    return fallbackIso
  }

  const [, digits] = matched
  const year = Number(digits.slice(0, 4))
  const month = Number(digits.slice(4, 6))
  const day = Number(digits.slice(6, 8))
  const iso = new Date(Date.UTC(year, month - 1, day)).toISOString()
  return Number.isNaN(Date.parse(iso)) ? fallbackIso : iso
}

function isStructuralHeading(line) {
  return /^(目\s*录|附\s*则|第[一二三四五六七八九十百千万零〇两0-9]+(编|章|节|分编)|[一二三四五六七八九十]+、)/u.test(line)
}

function parseArticles(text, documentId) {
  const lines = normalizeText(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)

  const articles = []
  let current = null

  const flushCurrent = () => {
    if (!current) {
      return
    }

    const content = current.contentParts.join('\n').trim()
    if (!content) {
      current = null
      return
    }

    articles.push({
      id: createStableId('article', `${documentId}:${current.articleNumber}`),
      documentId,
      articleNumber: current.articleNumber,
      content,
      plainText: content,
      aliases: [],
      topicTags: [],
    })
    current = null
  }

  for (const line of lines) {
    const matched = line.match(articleNumberPattern)
    if (matched) {
      flushCurrent()
      current = {
        articleNumber: matched[1],
        contentParts: matched[3] ? [matched[3].trim()] : [],
      }
      continue
    }

    if (!current) {
      continue
    }

    if (isStructuralHeading(line)) {
      continue
    }

    current.contentParts.push(line)
  }

  flushCurrent()
  return articles
}

async function loadEmbeddingHelpers() {
  const moduleUrl = pathToFileURL(path.join(serverRoot, 'dist', 'integrations', 'embedding-service.js')).href
  const module = await import(moduleUrl)
  if (typeof module.createEmbeddings !== 'function' || typeof module.isEmbeddingConfigured !== 'function') {
    throw new Error('无法加载 Embedding 服务模块。')
  }

  return module
}

async function buildSeed() {
  const generatedAt = new Date().toISOString()
  const emptySeed = {
    generatedAt,
    sourceDir: defaultLawSourceDir,
    knowledgeFiles: [],
    knowledgeStatutes: [],
    localRagIndex: {
      version: 1,
      files: {},
    },
  }

  if (!fs.existsSync(defaultLawSourceDir)) {
    return emptySeed
  }

  const entries = fs.readdirSync(defaultLawSourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.docx'))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

  if (!entries.length) {
    return emptySeed
  }

  const { createEmbeddings, isEmbeddingConfigured } = await loadEmbeddingHelpers()
  if (!isEmbeddingConfigured()) {
    throw new Error('打包默认法律库失败：当前未配置 Embedding API，无法预生成本地检索索引。')
  }

  const knowledgeFiles = []
  const knowledgeStatutes = []
  const ragFiles = {}

  for (const entry of entries) {
    const absolutePath = path.join(defaultLawSourceDir, entry.name)
    const relativePath = `法律文件/${entry.name}`
    const raw = await mammoth.extractRawText({ path: absolutePath })
    const extractedText = normalizeText(raw.value)
    if (!extractedText) {
      continue
    }

    const title = extractedText.split('\n').map((line) => line.trim()).find(Boolean) || entry.name.replace(/\.docx$/i, '')
    const documentId = createStableId('statute', relativePath)
    const fileId = createStableId('knowledge-file', relativePath)
    const publishDate = toIsoDateFromFileName(entry.name, generatedAt)
    const articles = parseArticles(extractedText, documentId)
    const chunks = chunkKnowledgeText(extractedText)
    const embeddings = chunks.length ? await createEmbeddings(chunks) : []
    const roundedEmbeddings = embeddings.map((embedding) => embedding.map((value) => Number(value.toFixed(6))))
    const keywords = buildKnowledgeVectorKeywords(title, extractedText)

    knowledgeStatutes.push({
      id: documentId,
      title,
      docType: inferDocType(title),
      issuer: inferIssuer(title),
      effectiveStatus: inferEffectiveStatus(),
      effectiveDate: publishDate,
      publishDate,
      revisionDate: publishDate,
      version: entry.name.match(/_(\d{8})(?=\.docx$)/i)?.[1] ?? publishDate.slice(0, 10),
      sourceAuthority: '内置法律文件库',
      sourceVerifiedAt: generatedAt,
      keywords,
      articles,
    })

    knowledgeFiles.push({
      id: fileId,
      title,
      fileName: relativePath,
      fileExtension: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileKind: 'word',
      uploadedAt: generatedAt,
      updatedAt: generatedAt,
      fileSize: fs.statSync(absolutePath).size,
      extractionStatus: 'ready',
      extractedText,
      summary: summarizeKnowledgeText(extractedText),
      vectorStatus: chunks.length ? 'ready' : 'pending',
      vectorChunkCount: chunks.length,
      vectorKeywords: keywords,
      vectorUpdatedAt: chunks.length ? generatedAt : undefined,
      linkedStatuteIds: [documentId],
    })

    ragFiles[fileId] = {
      fileId,
      fileTitle: title,
      fileName: relativePath,
      updatedAt: generatedAt,
      chunks: chunks.map((chunk, index) => ({
        fileId,
        fileTitle: title,
        fileName: relativePath,
        chunkIndex: index,
        content: chunk,
        embedding: roundedEmbeddings[index] ?? [],
        updatedAt: generatedAt,
      })),
    }
  }

  return {
    generatedAt,
    sourceDir: defaultLawSourceDir,
    knowledgeFiles,
    knowledgeStatutes,
    localRagIndex: {
      version: 1,
      files: ragFiles,
    },
  }
}

async function prepareDefaultLawLibrary() {
  const seed = await buildSeed()
  fs.mkdirSync(desktopSeedRoot, { recursive: true })
  fs.writeFileSync(outputFilePath, JSON.stringify(seed, null, 2), 'utf8')
  console.log(`Prepared bundled law library at ${outputFilePath}`)
}

module.exports = {
  prepareDefaultLawLibrary,
}
