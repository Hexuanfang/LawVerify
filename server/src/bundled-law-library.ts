import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { KnowledgeFileRecord, KnowledgeStatuteDocument } from './domain.js'
import { getRuntimeRoot } from './config/paths.js'

type BundledKnowledgeChunkEntry = {
  fileId: string
  fileTitle: string
  fileName: string
  chunkIndex: number
  content: string
  embedding: number[]
  updatedAt: string
}

type BundledKnowledgeFileEntry = {
  fileId: string
  fileTitle: string
  fileName: string
  updatedAt: string
  chunks: BundledKnowledgeChunkEntry[]
}

export type BundledLocalKnowledgeRagIndex = {
  version: 1
  files: Record<string, BundledKnowledgeFileEntry>
}

type BundledLawLibrarySeed = {
  generatedAt: string
  sourceDir: string
  knowledgeFiles: KnowledgeFileRecord[]
  knowledgeStatutes: KnowledgeStatuteDocument[]
  localRagIndex: BundledLocalKnowledgeRagIndex
}

let cachedSeed: BundledLawLibrarySeed | null | undefined

function cloneSeed(seed: BundledLawLibrarySeed) {
  return JSON.parse(JSON.stringify(seed)) as BundledLawLibrarySeed
}

function getSeedFilePath() {
  return path.join(getRuntimeRoot(), 'seeds', 'default-law-library.json')
}

export function readBundledLawLibrarySeed() {
  if (cachedSeed !== undefined) {
    return cachedSeed ? cloneSeed(cachedSeed) : null
  }

  const seedFilePath = getSeedFilePath()
  if (!existsSync(seedFilePath)) {
    cachedSeed = null
    return null
  }

  try {
    const raw = readFileSync(seedFilePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<BundledLawLibrarySeed>
    cachedSeed = {
      generatedAt: parsed.generatedAt ?? new Date(0).toISOString(),
      sourceDir: parsed.sourceDir ?? '',
      knowledgeFiles: Array.isArray(parsed.knowledgeFiles) ? parsed.knowledgeFiles : [],
      knowledgeStatutes: Array.isArray(parsed.knowledgeStatutes) ? parsed.knowledgeStatutes : [],
      localRagIndex: {
        version: 1,
        files: parsed.localRagIndex?.files ?? {},
      },
    }
    return cloneSeed(cachedSeed)
  } catch {
    cachedSeed = null
    return null
  }
}
