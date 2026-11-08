export type EvidenceChunk = {
  index: number
  content: string
  page?: number
}

export type EvidenceChunkIndex = {
  chunks: EvidenceChunk[]
  postings: Map<string, number[]>
  lengths: number[]
  averageLength: number
}

export type EvidenceChunkSelection = {
  chunks: EvidenceChunk[]
  totalChunks: number
  coveredChunks: number
  totalChars: number
  coveredChars: number
  coveredChunkIndexes: number[]
}

// 单块目标字数与上限：太小会切碎句子，太大则失去检索精度。
export const CHUNK_TARGET_CHARS = 600
export const CHUNK_MAX_CHARS = 800
// 索引规模上限：超过后自动放大块尺寸，保证整份材料仍可被检索。
export const MAX_INDEXED_CHUNKS = 20000
// 命中后带回的相邻块数量：命中块的前后各一块。
export const NEIGHBOR_CHUNK_SIZE = 1

const PAGE_MARKER = /-{2,}\s*第\s*(\d+)\s*\/\s*(\d+)\s*页\s*-{2,}/g

function tokenize(text: string) {
  const tokens: string[] = []
  const lower = text.toLowerCase()

  for (const matched of lower.matchAll(/[a-z0-9]{2,}/g)) {
    tokens.push(matched[0])
  }

  // 中文按二元组切分：不需要分词词典，也比单字更有区分度。
  for (const part of lower.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
    if (!part) {
      continue
    }
    if (part.length === 1) {
      tokens.push(part)
      continue
    }
    for (let index = 0; index < part.length - 1; index += 1) {
      tokens.push(part.slice(index, index + 2))
    }
  }

  return tokens
}

export function splitEvidenceTextIntoPages(text: string) {
  const pages: Array<{ page?: number; content: string }> = []
  PAGE_MARKER.lastIndex = 0
  const first = PAGE_MARKER.exec(text)
  if (!first) {
    return [{ page: undefined, content: text }]
  }

  const head = text.slice(0, first.index).trim()
  if (head) {
    pages.push({ page: undefined, content: head })
  }

  let matched: RegExpExecArray | null = first
  while (matched) {
    const page = Number(matched[1])
    const start = matched.index + matched[0].length
    const next = PAGE_MARKER.exec(text)
    const end = next ? next.index : text.length
    const content = text.slice(start, end).trim()
    if (content) {
      pages.push({ page: Number.isFinite(page) ? page : undefined, content })
    }
    matched = next
  }

  return pages
}

function splitPageContent(content: string, targetChars: number, maxChars: number) {
  const pieces: string[] = []
  const sentences = content.split(/(?<=[。！？；!?;\n])/u)
  let buffer = ''

  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed) {
      pieces.push(trimmed)
    }
    buffer = ''
  }

  for (const sentence of sentences) {
    if (!sentence) {
      continue
    }

    if (sentence.length > maxChars) {
      flush()
      for (let offset = 0; offset < sentence.length; offset += maxChars) {
        pieces.push(sentence.slice(offset, offset + maxChars))
      }
      continue
    }

    if (buffer && buffer.length + sentence.length > maxChars) {
      flush()
    }

    buffer += sentence
    if (buffer.length >= targetChars) {
      flush()
    }
  }

  flush()
  return pieces
}

export function buildEvidenceChunks(text: string, options: { targetChars?: number; maxChars?: number } = {}) {
  const totalChars = text.length
  // 文本太长时放大块尺寸，保证索引规模可控且覆盖整份材料。
  const estimatedChunks = Math.ceil(totalChars / (options.targetChars ?? CHUNK_TARGET_CHARS))
  const scale = estimatedChunks > MAX_INDEXED_CHUNKS
    ? Math.ceil(estimatedChunks / MAX_INDEXED_CHUNKS)
    : 1
  const targetChars = (options.targetChars ?? CHUNK_TARGET_CHARS) * scale
  const maxChars = (options.maxChars ?? CHUNK_MAX_CHARS) * scale

  const chunks: EvidenceChunk[] = []
  for (const page of splitEvidenceTextIntoPages(text)) {
    for (const piece of splitPageContent(page.content, targetChars, maxChars)) {
      chunks.push({ index: chunks.length, content: piece, page: page.page })
    }
  }

  return chunks
}

export function buildEvidenceChunkIndex(chunks: EvidenceChunk[]): EvidenceChunkIndex {
  const postings = new Map<string, number[]>()
  const lengths: number[] = []
  let totalLength = 0

  chunks.forEach((chunk, chunkIndex) => {
    const tokens = tokenize(chunk.content)
    lengths[chunkIndex] = tokens.length
    totalLength += tokens.length
    const unique = new Set(tokens)
    for (const token of unique) {
      const list = postings.get(token)
      if (list) {
        list.push(chunkIndex)
      } else {
        postings.set(token, [chunkIndex])
      }
    }
  })

  return {
    chunks,
    postings,
    lengths,
    averageLength: chunks.length ? totalLength / chunks.length : 0,
  }
}

// BM25 打分：查询词在块内出现越多、块越短，命中越靠前。
export function rankEvidenceChunks(index: EvidenceChunkIndex, queries: string[]) {
  if (!index.chunks.length) {
    return []
  }

  const queryTokens = [...new Set(queries.flatMap((query) => tokenize(query)))]
  if (!queryTokens.length) {
    return []
  }

  const k1 = 1.2
  const b = 0.75
  const total = index.chunks.length
  const scores = new Map<number, number>()

  for (const token of queryTokens) {
    const posting = index.postings.get(token)
    if (!posting?.length) {
      continue
    }

    const idf = Math.log(1 + (total - posting.length + 0.5) / (posting.length + 0.5))
    for (const chunkIndex of posting) {
      const length = index.lengths[chunkIndex] ?? 0
      const average = index.averageLength || 1
      const frequency = countOccurrences(index.chunks[chunkIndex].content, token)
      const denominator = frequency + k1 * (1 - b + b * (length / average))
      const score = idf * ((frequency * (k1 + 1)) / (denominator || 1))
      scores.set(chunkIndex, (scores.get(chunkIndex) ?? 0) + score)
    }
  }

  return [...scores.entries()]
    .map(([chunkIndex, score]) => ({ chunkIndex, score }))
    .sort((left, right) => right.score - left.score || left.chunkIndex - right.chunkIndex)
}

export function searchEvidenceChunkIndex(index: EvidenceChunkIndex, queries: string[], limit: number) {
  return rankEvidenceChunks(index, queries)
    .slice(0, Math.max(0, limit))
    .map((item) => item.chunkIndex)
}

function countOccurrences(content: string, token: string) {
  if (!token) {
    return 0
  }

  let count = 0
  let cursor = content.indexOf(token)
  while (cursor !== -1) {
    count += 1
    cursor = content.indexOf(token, cursor + token.length)
  }

  return count
}

// 命中块带回相邻块：上下文往往在前后一块，单独命中会断掉叙事。
export function expandChunkIndexes(chunkIndexes: number[], total: number, neighborSize = NEIGHBOR_CHUNK_SIZE) {
  const selected = new Set<number>()
  for (const chunkIndex of chunkIndexes) {
    for (let offset = -neighborSize; offset <= neighborSize; offset += 1) {
      const neighbor = chunkIndex + offset
      if (neighbor >= 0 && neighbor < total) {
        selected.add(neighbor)
      }
    }
  }
  return [...selected].sort((left, right) => left - right)
}

export function selectEvidenceChunksForUnderstanding(input: {
  text: string
  queries: string[]
  maxChars?: number
  maxChunks?: number
  neighborSize?: number
  excludeChunkIndexes?: number[]
}): EvidenceChunkSelection {
  const chunks = buildEvidenceChunks(input.text)
  const totalChars = input.text.length
  if (!chunks.length) {
    return {
      chunks: [],
      totalChunks: 0,
      coveredChunks: 0,
      totalChars,
      coveredChars: 0,
      coveredChunkIndexes: [],
    }
  }

  const index = buildEvidenceChunkIndex(chunks)
  const ranked = rankEvidenceChunks(index, input.queries).slice(0, Math.max(0, input.maxChunks ?? 64))
  const excluded = new Set(input.excludeChunkIndexes ?? [])

  const maxChars = input.maxChars ?? 48000
  const neighborSize = input.neighborSize ?? NEIGHBOR_CHUNK_SIZE
  const selectedIndexes = new Set<number>()
  let coveredChars = 0
  // 检索词全部落空时按均匀间隔兜底采样：检索依赖语言与用词，
  // 均匀覆盖不依赖，遇到英文或与争点无关的材料时仍然能读到有代表性的内容。
  const candidates = ranked.length
    ? ranked.map((item) => item.chunkIndex)
    : spreadChunkIndexes(chunks.length, input.maxChunks ?? 64)
  // 按命中分数从高到低取块，命中块连同前后相邻块一起带走，顺序按原文排列。
  for (const chunkIndex of candidates) {
    for (const neighbor of expandChunkIndexes([chunkIndex], chunks.length, neighborSize)) {
      if (excluded.has(neighbor) || selectedIndexes.has(neighbor)) {
        continue
      }
      if (coveredChars + chunks[neighbor].content.length > maxChars && selectedIndexes.size) {
        continue
      }
      selectedIndexes.add(neighbor)
      coveredChars += chunks[neighbor].content.length
    }
  }

  const orderedIndexes = [...selectedIndexes].sort((left, right) => left - right)
  const selected = orderedIndexes.map((chunkIndex) => chunks[chunkIndex])

  return {
    chunks: selected,
    totalChunks: chunks.length,
    coveredChunks: selected.length,
    totalChars,
    coveredChars,
    coveredChunkIndexes: orderedIndexes,
  }
}

// 均匀间隔取块：检索落空时保证整份材料仍有代表性的内容被理解。
function spreadChunkIndexes(total: number, limit: number) {
  if (total <= 0 || limit <= 0) {
    return []
  }

  const take = Math.min(total, limit)
  const stride = Math.max(1, Math.floor(total / take))
  const indexes: number[] = []
  for (let index = 0; index < total && indexes.length < take; index += stride) {
    indexes.push(index)
  }
  return indexes
}
