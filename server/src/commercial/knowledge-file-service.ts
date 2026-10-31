import path from 'node:path'
import { extractWordText } from '../infrastructure/document-jobs.js'
import type { KnowledgeFileRecord } from '../domain.js'
import { AppError } from '../core/app-error.js'
import { readObject, storeObject } from '../infrastructure/object-storage.js'
import { query } from '../infrastructure/postgres.js'
import { createEmbeddings, createEmbedding, isEmbeddingConfigured } from '../integrations/embedding-service.js'
import {
  deleteKnowledgePoints,
  ensureKnowledgeCollection,
  isQdrantConfigured,
  searchKnowledgePoints,
  upsertKnowledgePoints,
} from '../integrations/qdrant-service.js'
import { recordAuditEvent } from './audit-service.js'

const WORKSPACE_ORGANIZATION_SLUG = 'local-workspace'

type KnowledgeUploadManifestItem = {
  title?: string
  relativePath?: string
}

type ExtractionResult = {
  extractedText: string
  extractionStatus: KnowledgeFileRecord['extractionStatus']
  extractionError?: string
}

type KnowledgeFileRow = {
  id: string
  title: string
  original_file_name: string
  relative_path: string
  storage_key: string | null
  mime_type: string
  file_extension: string
  file_kind: KnowledgeFileRecord['fileKind']
  file_size: number | string
  extraction_status: KnowledgeFileRecord['extractionStatus']
  extraction_error: string | null
  extracted_text: string
  summary: string
  vector_status: KnowledgeFileRecord['vectorStatus']
  vector_error: string | null
  vector_chunk_count: number
  vector_keywords: unknown
  vector_updated_at: string | null
  linked_statute_ids: unknown
  uploaded_at: string
  updated_at: string
}

type KnowledgeChunkRow = {
  pointId: string
  chunkIndex: number
  content: string
  keywordPayload: string[]
  charCount: number
  embeddingStatus: KnowledgeFileRecord['vectorStatus']
  embeddingError?: string
  embeddingUpdatedAt?: string
}

type StoredChunkRow = {
  point_id: string | null
  chunk_index: number
  content: string
  file_id: string
  title: string
  relative_path: string
  original_file_name: string
}

export interface CommercialKnowledgeRagChunk {
  fileId: string
  fileTitle: string
  fileName: string
  chunkIndex: number
  content: string
  score: number
}

function inferKnowledgeFileKind(fileName: string, mimeType: string): KnowledgeFileRecord['fileKind'] {
  const lowerName = fileName.toLowerCase()
  const lowerMime = mimeType.toLowerCase()

  if (
    lowerName.endsWith('.pdf')
    || lowerMime.includes('pdf')
  ) {
    return 'pdf'
  }

  if (
    lowerName.endsWith('.doc')
    || lowerName.endsWith('.docx')
    || lowerName.endsWith('.rtf')
    || lowerName.endsWith('.wps')
    || lowerMime.includes('word')
    || lowerMime.includes('officedocument.wordprocessingml')
    || lowerMime.includes('rtf')
  ) {
    return 'word'
  }

  if (
    lowerName.endsWith('.txt')
    || lowerName.endsWith('.md')
    || lowerName.endsWith('.markdown')
    || lowerMime.startsWith('text/')
  ) {
    return 'text'
  }

  return 'other'
}

function chunkKnowledgeText(text: string, chunkSize = 800) {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean)

  if (!paragraphs.length) {
    return [] as string[]
  }

  const chunks: string[] = []
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

function extractRegexMatches(text: string, pattern: RegExp, limit = 32) {
  const matched = text.match(pattern) ?? []
  return matched.slice(0, limit)
}

function uniqueStrings(values: string[], limit = values.length) {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    result.push(normalized)

    if (result.length >= limit) {
      break
    }
  }

  return result
}

function summarizeKnowledgeText(text: string) {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return '文件已上传，待完成文本抽取后再参与检索。'
  }

  return compact.length <= 120 ? compact : `${compact.slice(0, 120)}...`
}

function buildKnowledgeVectorKeywords(title: string, text: string) {
  const candidates = extractRegexMatches(
    `${title}\n${text}`,
    /[\u4e00-\u9fa5A-Za-z0-9]{2,20}/g,
    64,
  )

  return uniqueStrings(
    candidates.filter((item) => !/^\d+$/.test(item)),
    18,
  )
}

function stripRtfControlText(content: string) {
  return content
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+\d* ?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeArrayStrings(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[]
  }

  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

function buildKnowledgeChunkPointId(fileId: string, chunkIndex: number) {
  return `knowledge:${fileId}:${chunkIndex}`
}

function buildVectorConfigurationError() {
  return '商用 RAG 向量能力尚未完成配置，请设置 Embedding 与 Qdrant 后再重试。'
}

async function ensureWorkspaceOrganization() {
  const result = await query<{ id: string }>(
    `
      INSERT INTO organizations (name, slug)
      VALUES ($1, $2)
      ON CONFLICT (slug)
      DO UPDATE SET updated_at = NOW()
      RETURNING id
    `,
    ['LawVerify 本地工作区', WORKSPACE_ORGANIZATION_SLUG],
  )

  return result.rows[0].id
}

async function extractKnowledgeText(file: Express.Multer.File, relativePath: string): Promise<ExtractionResult> {
  const fileName = relativePath || file.originalname
  const lowerName = fileName.toLowerCase()

  if (
    lowerName.endsWith('.txt')
    || lowerName.endsWith('.md')
    || lowerName.endsWith('.markdown')
    || file.mimetype.startsWith('text/')
  ) {
    return {
      extractedText: file.buffer.toString('utf8').trim(),
      extractionStatus: 'ready',
    }
  }

  if (lowerName.endsWith('.rtf') || file.mimetype.toLowerCase().includes('rtf')) {
    return {
      extractedText: stripRtfControlText(file.buffer.toString('utf8')).trim(),
      extractionStatus: 'ready',
    }
  }

  if (lowerName.endsWith('.docx')) {
    try {
      const text = await extractWordText(file.buffer)
      return {
        extractedText: text.trim(),
        extractionStatus: 'ready',
      }
    } catch (error) {
      return {
        extractedText: '',
        extractionStatus: 'failed',
        extractionError: error instanceof Error ? error.message : 'DOCX 正文抽取失败。',
      }
    }
  }

  if (lowerName.endsWith('.pdf')) {
    return {
      extractedText: '',
      extractionStatus: 'pending',
      extractionError: 'PDF 文件已上传，当前版本待接入专用解析/OCR 管线后再执行正文抽取。',
    }
  }

  if (lowerName.endsWith('.doc') || lowerName.endsWith('.wps')) {
    return {
      extractedText: '',
      extractionStatus: 'pending',
      extractionError: '旧版 Word/WPS 文件已上传，建议另存为 .docx 后即可自动抽取正文。',
    }
  }

  return {
    extractedText: '',
    extractionStatus: 'pending',
    extractionError: '文件已上传，当前格式尚未接入自动抽取管线。',
  }
}

function mapKnowledgeFileRow(row: KnowledgeFileRow): KnowledgeFileRecord {
  return {
    id: row.id,
    title: row.title,
    fileName: row.relative_path || row.original_file_name,
    fileExtension: row.file_extension,
    mimeType: row.mime_type,
    fileKind: row.file_kind,
    uploadedAt: row.uploaded_at,
    updatedAt: row.updated_at,
    fileSize: Number(row.file_size),
    extractionStatus: row.extraction_status,
    extractionError: row.extraction_error ?? undefined,
    extractedText: row.extracted_text,
    summary: row.summary,
    vectorStatus: row.vector_status,
    vectorError: row.vector_error ?? undefined,
    vectorChunkCount: row.vector_chunk_count,
    vectorKeywords: normalizeArrayStrings(row.vector_keywords),
    vectorUpdatedAt: row.vector_updated_at ?? undefined,
    linkedStatuteIds: normalizeArrayStrings(row.linked_statute_ids),
  }
}

async function fetchKnowledgeFileById(organizationId: string, fileId: string) {
  const result = await query<KnowledgeFileRow>(
    `
      SELECT
        id,
        title,
        original_file_name,
        relative_path,
        storage_key,
        mime_type,
        file_extension,
        file_kind,
        file_size,
        extraction_status,
        extraction_error,
        extracted_text,
        summary,
        vector_status,
        vector_error,
        vector_chunk_count,
        vector_keywords,
        vector_updated_at,
        linked_statute_ids,
        uploaded_at,
        updated_at
      FROM knowledge_files
      WHERE organization_id = $1 AND id = $2
      LIMIT 1
    `,
    [organizationId, fileId],
  )

  return result.rows[0] ?? null
}

async function removeKnowledgeChunks(fileId: string) {
  const existing = await query<{ point_id: string | null }>(
    'SELECT point_id FROM knowledge_file_chunks WHERE knowledge_file_id = $1',
    [fileId],
  )

  const pointIds = existing.rows
    .map((item) => item.point_id?.trim() || '')
    .filter(Boolean)

  if (pointIds.length) {
    await deleteKnowledgePoints(pointIds)
  }

  await query('DELETE FROM knowledge_file_chunks WHERE knowledge_file_id = $1', [fileId])
}

async function replaceKnowledgeChunks(fileId: string, chunks: KnowledgeChunkRow[]) {
  await removeKnowledgeChunks(fileId)

  for (const chunk of chunks) {
    await query(
      `
        INSERT INTO knowledge_file_chunks (
          knowledge_file_id,
          chunk_index,
          content,
          keyword_payload,
          point_id,
          char_count,
          embedding_status,
          embedding_error,
          embedding_updated_at
        ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
      `,
      [
        fileId,
        chunk.chunkIndex,
        chunk.content,
        JSON.stringify(chunk.keywordPayload),
        chunk.pointId,
        chunk.charCount,
        chunk.embeddingStatus,
        chunk.embeddingError ?? null,
        chunk.embeddingUpdatedAt ?? null,
      ],
    )
  }
}

async function buildKnowledgeVectorPayload(input: {
  organizationId: string
  fileId: string
  title: string
  fileName: string
  extractedText: string
  extractionStatus: KnowledgeFileRecord['extractionStatus']
  linkedStatuteIds: string[]
}) {
  const extractedText = input.extractedText.trim()
  const summary = summarizeKnowledgeText(extractedText)

  if (!extractedText) {
    return {
      summary,
      vectorStatus: input.extractionStatus === 'failed' ? 'failed' : 'pending' as KnowledgeFileRecord['vectorStatus'],
      vectorError:
        input.extractionStatus === 'failed'
          ? '正文抽取失败，暂未进入向量索引阶段。'
          : '当前文件尚未完成正文抽取，暂未进入向量索引阶段。',
      vectorChunkCount: 0,
      vectorKeywords: [] as string[],
      vectorUpdatedAt: undefined as string | undefined,
      chunks: [] as KnowledgeChunkRow[],
      points: [] as Array<{
        id: string
        vector: number[]
        payload: Record<string, unknown>
      }>,
    }
  }

  const textChunks = chunkKnowledgeText(extractedText)
  const keywords = buildKnowledgeVectorKeywords(input.title, extractedText)

  if (!textChunks.length) {
    return {
      summary,
      vectorStatus: 'failed' as const,
      vectorError: '正文抽取结果为空，未生成可入库的知识分块。',
      vectorChunkCount: 0,
      vectorKeywords: keywords,
      vectorUpdatedAt: undefined,
      chunks: [] as KnowledgeChunkRow[],
      points: [] as Array<{
        id: string
        vector: number[]
        payload: Record<string, unknown>
      }>,
    }
  }

  if (!isEmbeddingConfigured() || !isQdrantConfigured()) {
    return {
      summary,
      vectorStatus: 'failed' as const,
      vectorError: buildVectorConfigurationError(),
      vectorChunkCount: textChunks.length,
      vectorKeywords: keywords,
      vectorUpdatedAt: undefined,
      chunks: textChunks.map((chunk, chunkIndex) => ({
        pointId: buildKnowledgeChunkPointId(input.fileId, chunkIndex),
        chunkIndex,
        content: chunk,
        keywordPayload: keywords,
        charCount: chunk.length,
        embeddingStatus: 'failed' as const,
        embeddingError: buildVectorConfigurationError(),
      })),
      points: [] as Array<{
        id: string
        vector: number[]
        payload: Record<string, unknown>
      }>,
    }
  }

  try {
    const embeddings = await createEmbeddings(textChunks)
    await ensureKnowledgeCollection(embeddings[0].length)
    const embeddingUpdatedAt = new Date().toISOString()

    return {
      summary,
      vectorStatus: 'ready' as const,
      vectorError: undefined,
      vectorChunkCount: textChunks.length,
      vectorKeywords: keywords,
      vectorUpdatedAt: embeddingUpdatedAt,
      chunks: textChunks.map((chunk, chunkIndex) => ({
        pointId: buildKnowledgeChunkPointId(input.fileId, chunkIndex),
        chunkIndex,
        content: chunk,
        keywordPayload: keywords,
        charCount: chunk.length,
        embeddingStatus: 'ready' as const,
        embeddingUpdatedAt,
      })),
      points: textChunks.map((chunk, chunkIndex) => ({
        id: buildKnowledgeChunkPointId(input.fileId, chunkIndex),
        vector: embeddings[chunkIndex],
        payload: {
          organizationId: input.organizationId,
          fileId: input.fileId,
          fileTitle: input.title,
          fileName: input.fileName,
          chunkIndex,
          linkedStatuteIds: input.linkedStatuteIds,
          content: chunk,
        },
      })),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '知识向量化失败。'

    return {
      summary,
      vectorStatus: 'failed' as const,
      vectorError: message,
      vectorChunkCount: textChunks.length,
      vectorKeywords: keywords,
      vectorUpdatedAt: undefined,
      chunks: textChunks.map((chunk, chunkIndex) => ({
        pointId: buildKnowledgeChunkPointId(input.fileId, chunkIndex),
        chunkIndex,
        content: chunk,
        keywordPayload: keywords,
        charCount: chunk.length,
        embeddingStatus: 'failed' as const,
        embeddingError: message,
      })),
      points: [] as Array<{
        id: string
        vector: number[]
        payload: Record<string, unknown>
      }>,
    }
  }
}

async function upsertKnowledgeFileBaseRecord(input: {
  organizationId: string
  title: string
  originalFileName: string
  relativePath: string
  mimeType: string
  fileSize: number
  storageProvider: string
  storageBucket: string
  storageKey: string
  storageUrl: string
  extraction: ExtractionResult
}) {
  const result = await query<KnowledgeFileRow>(
    `
      INSERT INTO knowledge_files (
        organization_id,
        title,
        original_file_name,
        relative_path,
        mime_type,
        file_extension,
        file_kind,
        file_size,
        storage_provider,
        storage_bucket,
        storage_key,
        storage_url,
        extraction_status,
        extraction_error,
        extracted_text,
        summary,
        vector_status,
        vector_error,
        vector_chunk_count,
        vector_keywords,
        vector_updated_at,
        linked_statute_ids,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22::jsonb, NOW()
      )
      ON CONFLICT (organization_id, relative_path)
      DO UPDATE SET
        title = EXCLUDED.title,
        original_file_name = EXCLUDED.original_file_name,
        mime_type = EXCLUDED.mime_type,
        file_extension = EXCLUDED.file_extension,
        file_kind = EXCLUDED.file_kind,
        file_size = EXCLUDED.file_size,
        storage_provider = EXCLUDED.storage_provider,
        storage_bucket = EXCLUDED.storage_bucket,
        storage_key = EXCLUDED.storage_key,
        storage_url = EXCLUDED.storage_url,
        extraction_status = EXCLUDED.extraction_status,
        extraction_error = EXCLUDED.extraction_error,
        extracted_text = EXCLUDED.extracted_text,
        summary = EXCLUDED.summary,
        vector_status = EXCLUDED.vector_status,
        vector_error = EXCLUDED.vector_error,
        vector_chunk_count = EXCLUDED.vector_chunk_count,
        vector_keywords = EXCLUDED.vector_keywords,
        vector_updated_at = EXCLUDED.vector_updated_at,
        updated_at = NOW()
      RETURNING
        id,
        title,
        original_file_name,
        relative_path,
        storage_key,
        mime_type,
        file_extension,
        file_kind,
        file_size,
        extraction_status,
        extraction_error,
        extracted_text,
        summary,
        vector_status,
        vector_error,
        vector_chunk_count,
        vector_keywords,
        vector_updated_at,
        linked_statute_ids,
        uploaded_at,
        updated_at
    `,
    [
      input.organizationId,
      input.title,
      input.originalFileName,
      input.relativePath,
      input.mimeType,
      path.extname(input.relativePath).toLowerCase(),
      inferKnowledgeFileKind(input.relativePath, input.mimeType),
      input.fileSize,
      input.storageProvider,
      input.storageBucket,
      input.storageKey,
      input.storageUrl,
      input.extraction.extractionStatus,
      input.extraction.extractionError ?? null,
      input.extraction.extractedText,
      summarizeKnowledgeText(input.extraction.extractedText),
      input.extraction.extractedText.trim() ? 'pending' : input.extraction.extractionStatus === 'failed' ? 'failed' : 'pending',
      input.extraction.extractedText.trim() ? '正在生成 embedding 并写入 Qdrant。' : input.extraction.extractionError ?? null,
      0,
      JSON.stringify([]),
      null,
      JSON.stringify([]),
    ],
  )

  return result.rows[0]
}

async function finalizeKnowledgeFileRecord(input: {
  organizationId: string
  fileId: string
  extractionStatus: KnowledgeFileRecord['extractionStatus']
  extractionError?: string
  extractedText: string
  summary: string
  vectorStatus: KnowledgeFileRecord['vectorStatus']
  vectorError?: string
  vectorChunkCount: number
  vectorKeywords: string[]
  vectorUpdatedAt?: string
}) {
  const result = await query<KnowledgeFileRow>(
    `
      UPDATE knowledge_files
      SET
        extraction_status = $3,
        extraction_error = $4,
        extracted_text = $5,
        summary = $6,
        vector_status = $7,
        vector_error = $8,
        vector_chunk_count = $9,
        vector_keywords = $10::jsonb,
        vector_updated_at = $11,
        updated_at = NOW()
      WHERE organization_id = $1 AND id = $2
      RETURNING
        id,
        title,
        original_file_name,
        relative_path,
        storage_key,
        mime_type,
        file_extension,
        file_kind,
        file_size,
        extraction_status,
        extraction_error,
        extracted_text,
        summary,
        vector_status,
        vector_error,
        vector_chunk_count,
        vector_keywords,
        vector_updated_at,
        linked_statute_ids,
        uploaded_at,
        updated_at
    `,
    [
      input.organizationId,
      input.fileId,
      input.extractionStatus,
      input.extractionError ?? null,
      input.extractedText,
      input.summary,
      input.vectorStatus,
      input.vectorError ?? null,
      input.vectorChunkCount,
      JSON.stringify(input.vectorKeywords),
      input.vectorUpdatedAt ?? null,
    ],
  )

  return result.rows[0]
}

async function indexKnowledgeFileRecord(input: {
  organizationId: string
  file: KnowledgeFileRow
  extractedText: string
  extractionStatus: KnowledgeFileRecord['extractionStatus']
  extractionError?: string
}) {
  let vectorPayload = await buildKnowledgeVectorPayload({
    organizationId: input.organizationId,
    fileId: input.file.id,
    title: input.file.title,
    fileName: input.file.relative_path || input.file.original_file_name,
    extractedText: input.extractedText,
    extractionStatus: input.extractionStatus,
    linkedStatuteIds: normalizeArrayStrings(input.file.linked_statute_ids),
  })

  try {
    await replaceKnowledgeChunks(input.file.id, vectorPayload.chunks)

    if (vectorPayload.points.length) {
      await upsertKnowledgePoints(vectorPayload.points)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '写入知识向量索引失败。'

    vectorPayload = {
      ...vectorPayload,
      vectorStatus: 'failed' as const,
      vectorError: message,
      vectorUpdatedAt: undefined,
      points: [] as Array<{
        id: string
        vector: number[]
        payload: Record<string, unknown>
      }>,
      chunks: vectorPayload.chunks.map((chunk) => ({
        ...chunk,
        embeddingStatus: 'failed' as const,
        embeddingError: message,
        embeddingUpdatedAt: undefined,
      })),
    }

    await replaceKnowledgeChunks(input.file.id, vectorPayload.chunks)
  }

  const updated = await finalizeKnowledgeFileRecord({
    organizationId: input.organizationId,
    fileId: input.file.id,
    extractionStatus: input.extractionStatus,
    extractionError: input.extractionError,
    extractedText: input.extractedText,
    summary: vectorPayload.summary,
    vectorStatus: vectorPayload.vectorStatus,
    vectorError: vectorPayload.vectorError,
    vectorChunkCount: vectorPayload.vectorChunkCount,
    vectorKeywords: vectorPayload.vectorKeywords,
    vectorUpdatedAt: vectorPayload.vectorUpdatedAt,
  })

  return mapKnowledgeFileRow(updated)
}

export async function listKnowledgeFilesForWorkspace() {
  const organizationId = await ensureWorkspaceOrganization()
  const result = await query<KnowledgeFileRow>(
    `
      SELECT
        id,
        title,
        original_file_name,
        relative_path,
        mime_type,
        file_extension,
        file_kind,
        file_size,
        extraction_status,
        extraction_error,
        extracted_text,
        summary,
        vector_status,
        vector_error,
        vector_chunk_count,
        vector_keywords,
        vector_updated_at,
        linked_statute_ids,
        uploaded_at,
        updated_at
      FROM knowledge_files
      WHERE organization_id = $1
      ORDER BY uploaded_at DESC, updated_at DESC
    `,
    [organizationId],
  )

  return result.rows.map(mapKnowledgeFileRow)
}

export async function uploadKnowledgeFilesToCommercialLibrary(input: {
  files: Express.Multer.File[]
  manifest?: KnowledgeUploadManifestItem[]
}) {
  if (!input.files.length) {
    throw new AppError('请至少上传一个知识文件。')
  }

  const organizationId = await ensureWorkspaceOrganization()
  const uploadedFiles: KnowledgeFileRecord[] = []

  for (const [index, file] of input.files.entries()) {
    const manifestItem = input.manifest?.[index]
    const relativePath = manifestItem?.relativePath?.trim() || file.originalname
    const title = manifestItem?.title?.trim() || path.basename(relativePath, path.extname(relativePath))
    const mimeType = file.mimetype?.trim() || 'application/octet-stream'
    const extraction = await extractKnowledgeText(file, relativePath)
    const stored = await storeObject(file, {
      bucket: 'knowledge',
      fileName: relativePath,
    })

    const baseRecord = await upsertKnowledgeFileBaseRecord({
      organizationId,
      title,
      originalFileName: file.originalname,
      relativePath,
      mimeType,
      fileSize: file.size,
      storageProvider: stored.provider,
      storageBucket: stored.bucket,
      storageKey: stored.key,
      storageUrl: stored.url,
      extraction,
    })

    const record = await indexKnowledgeFileRecord({
      organizationId,
      file: baseRecord,
      extractedText: extraction.extractedText.trim(),
      extractionStatus: extraction.extractionStatus,
      extractionError: extraction.extractionError?.trim() || undefined,
    })

    await recordAuditEvent({
      organizationId,
      action: 'knowledge.file.upload',
      entityType: 'knowledge_file',
      entityId: record.id,
      metadata: {
        fileName: record.fileName,
        mimeType: record.mimeType,
        size: record.fileSize ?? 0,
        extractionStatus: record.extractionStatus,
        vectorStatus: record.vectorStatus,
        vectorChunkCount: record.vectorChunkCount,
      },
    })

    uploadedFiles.push(record)
  }

  return uploadedFiles
}

export async function reindexCommercialKnowledgeFile(fileId: string) {
  const organizationId = await ensureWorkspaceOrganization()
  const current = await fetchKnowledgeFileById(organizationId, fileId)

  if (!current) {
    throw new AppError('知识文件不存在。', 404, 'KNOWLEDGE_FILE_NOT_FOUND')
  }

  let extractedText = current.extracted_text.trim()
  let extractionStatus = current.extraction_status
  let extractionError = current.extraction_error ?? undefined

  if (!extractedText) {
    const storageKey = current.storage_key?.trim()

    if (!storageKey) {
      throw new AppError('当前文件缺少原始文件定位信息，无法重新处理。', 400, 'KNOWLEDGE_FILE_STORAGE_MISSING')
    }

    const relativePath = current.relative_path || current.original_file_name

    try {
      const buffer = await readObject(storageKey)
      const extraction = await extractKnowledgeText({
        fieldname: 'file',
        originalname: path.basename(relativePath),
        encoding: '7bit',
        mimetype: current.mime_type || 'application/octet-stream',
        size: buffer.length,
        buffer,
        stream: undefined as unknown as Express.Multer.File['stream'],
        destination: '',
        filename: '',
        path: '',
      }, relativePath)

      extractedText = extraction.extractedText.trim()
      extractionStatus = extraction.extractionStatus
      extractionError = extraction.extractionError?.trim() || undefined
    } catch (error) {
      throw new AppError(
        error instanceof Error ? `读取原始文件失败：${error.message}` : '读取原始文件失败。',
        500,
        'KNOWLEDGE_FILE_READ_FAILED',
      )
    }
  }

  const record = await indexKnowledgeFileRecord({
    organizationId,
    file: current,
    extractedText,
    extractionStatus,
    extractionError,
  })

  await recordAuditEvent({
    organizationId,
    action: 'knowledge.file.reindex',
    entityType: 'knowledge_file',
    entityId: record.id,
    metadata: {
      fileName: record.fileName,
      extractionStatus: record.extractionStatus,
      vectorStatus: record.vectorStatus,
      vectorChunkCount: record.vectorChunkCount,
    },
  })

  return record
}

export async function searchCommercialKnowledgeFileRagChunks(input: {
  source: string
  limit?: number
}) {
  if (!input.source.trim() || !isEmbeddingConfigured() || !isQdrantConfigured()) {
    return [] as CommercialKnowledgeRagChunk[]
  }

  const organizationId = await ensureWorkspaceOrganization()
  const embedding = await createEmbedding(input.source.trim())
  await ensureKnowledgeCollection(embedding.length)
  const hits = await searchKnowledgePoints({
    vector: embedding,
    organizationId,
    limit: Math.max(1, input.limit ?? 6),
  })

  if (!hits.length) {
    return [] as CommercialKnowledgeRagChunk[]
  }

  const pointIds = hits.map((item) => String(item.id))
  const rows = await query<StoredChunkRow>(
    `
      SELECT
        chunk.point_id,
        chunk.chunk_index,
        chunk.content,
        file.id AS file_id,
        file.title,
        file.relative_path,
        file.original_file_name
      FROM knowledge_file_chunks AS chunk
      INNER JOIN knowledge_files AS file ON file.id = chunk.knowledge_file_id
      WHERE file.organization_id = $1 AND chunk.point_id = ANY($2::text[])
    `,
    [organizationId, pointIds],
  )

  const rowMap = new Map(rows.rows.map((item) => [item.point_id ?? '', item]))

  return hits
    .map((item) => {
      const row = rowMap.get(String(item.id))

      if (!row) {
        return null
      }

      return {
        fileId: row.file_id,
        fileTitle: row.title,
        fileName: row.relative_path || row.original_file_name,
        chunkIndex: row.chunk_index,
        content: row.content,
        score: item.score,
      } satisfies CommercialKnowledgeRagChunk
    })
    .filter((item): item is CommercialKnowledgeRagChunk => Boolean(item))
}
