import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readBundledLawLibrarySeed } from './bundled-law-library.js'
import { getWorkspaceDataDir } from './config/paths.js'

type LocalKnowledgeChunkEntry = {
  fileId: string
  fileTitle: string
  fileName: string
  chunkIndex: number
  content: string
  embedding: number[]
  updatedAt: string
}

type LocalKnowledgeFileEntry = {
  fileId: string
  fileTitle: string
  fileName: string
  updatedAt: string
  chunks: LocalKnowledgeChunkEntry[]
}

type LocalKnowledgeRagIndex = {
  version: 1
  files: Record<string, LocalKnowledgeFileEntry>
}

const indexFile = path.join(getWorkspaceDataDir(), 'knowledge-rag-index.json')

function cosineSimilarity(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length)
  if (!length) {
    return 0
  }

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }

  if (!leftNorm || !rightNorm) {
    return 0
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

async function readIndex() {
  await mkdir(getWorkspaceDataDir(), { recursive: true })

  try {
    const raw = await readFile(indexFile, 'utf8')
    const parsed = JSON.parse(raw) as LocalKnowledgeRagIndex
    return {
      version: 1 as const,
      files: parsed.files ?? {},
    }
  } catch (error) {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    if (errorCode !== 'ENOENT') {
      throw error
    }

    const bundledLawLibrary = readBundledLawLibrarySeed()
    if (bundledLawLibrary?.localRagIndex) {
      return {
        version: 1 as const,
        files: bundledLawLibrary.localRagIndex.files ?? {},
      }
    }

    return {
      version: 1 as const,
      files: {},
    }
  }
}

async function writeIndex(index: LocalKnowledgeRagIndex) {
  await mkdir(getWorkspaceDataDir(), { recursive: true })
  await writeFile(indexFile, JSON.stringify(index, null, 2), 'utf8')
}

export async function replaceLocalKnowledgeFileIndex(input: {
  fileId: string
  fileTitle: string
  fileName: string
  updatedAt: string
  chunks: Array<{
    chunkIndex: number
    content: string
    embedding: number[]
  }>
}) {
  const index = await readIndex()
  index.files[input.fileId] = {
    fileId: input.fileId,
    fileTitle: input.fileTitle,
    fileName: input.fileName,
    updatedAt: input.updatedAt,
    chunks: input.chunks.map((chunk) => ({
      fileId: input.fileId,
      fileTitle: input.fileTitle,
      fileName: input.fileName,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      embedding: chunk.embedding,
      updatedAt: input.updatedAt,
    })),
  }
  await writeIndex(index)
}

export async function removeLocalKnowledgeFileIndex(fileId: string) {
  const index = await readIndex()
  if (!(fileId in index.files)) {
    return
  }

  delete index.files[fileId]
  await writeIndex(index)
}

export async function searchLocalKnowledgeRagChunks(input: {
  embedding: number[]
  limit: number
}) {
  const index = await readIndex()
  const ranked = Object.values(index.files)
    .flatMap((file) =>
      file.chunks.map((chunk) => ({
        fileId: file.fileId,
        fileTitle: file.fileTitle,
        fileName: file.fileName,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        score: cosineSimilarity(input.embedding, chunk.embedding),
      })),
    )
    .filter((item) => Number.isFinite(item.score) && item.score > 0)
    .sort((left, right) => right.score - left.score)

  return ranked.slice(0, Math.max(1, input.limit))
}
