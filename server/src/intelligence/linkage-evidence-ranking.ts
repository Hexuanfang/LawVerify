import { setImmediate } from 'node:timers/promises'
import { buildEvidenceChunkIndex, buildEvidenceChunks, rankEvidenceChunks, type EvidenceChunk } from './evidence-retrieval.js'

type EvidenceExcerpt = { locator: string; text: string }
type EvidenceDocument = { id: string; number: string; name: string; fragments: EvidenceExcerpt[] }
type RankingSentence = { sentenceText: string; sentenceIndex: number; priority: 'high' | 'normal' }
type RankingParagraph = { id: string; sentences: RankingSentence[] }
type EvidenceCandidate = { evidenceId: string; sentenceIndexes: number[]; fragments: EvidenceExcerpt[] }
type Embed = (texts: string[], signal: AbortSignal) => Promise<ArrayLike<number>[]>
type EmbeddingOptions = {
  embedQueries?: Embed
  embedPassages?: Embed
  prepareText?: (text: string) => string
  maxQueries?: number
  maxPassages?: number
}

const CANDIDATES_PER_PARAGRAPH = 12
const EXCERPTS_PER_MATERIAL = 3
const RANK_FUSION_CONSTANT = 10

function normalizeAmount(value: string, unit: string) {
  const [whole, fraction = ''] = value.replace(/^[+-]/u, '').split('.')
  const shift = unit === '万' ? 4 : unit === '千' ? 3 : 0
  const integer = `${whole}${fraction.padEnd(shift, '0').slice(0, shift)}`.replace(/^0+(?=\d)/u, '')
  const decimals = fraction.slice(shift).replace(/0+$/u, '')
  const sign = value.startsWith('-') && (integer !== '0' || decimals) ? '-' : ''
  return `${sign}${integer}${decimals ? `.${decimals}` : ''}`
}

function extractFields(text: string) {
  const normalized = text.normalize('NFKC').replace(/(?<=\d),(?=\d{3}(?!\d))/gu, '').replace(/\s+/gu, '')
  return {
    dates: new Set([...normalized.matchAll(/(\d{4})(?:年|[-/.])(\d{1,2})(?:月|[-/.])(\d{1,2})(?:日|号)?/gu)]
      .map(match => match.slice(1).map(Number).join('-'))),
    amounts: new Set([...normalized.matchAll(/([+-]?\d+(?:\.\d+)?)(万|千)?元/gu)]
      .map(([, value, unit]) => normalizeAmount(value, unit))),
  }
}

type Fields = ReturnType<typeof extractFields>
type Passage = EvidenceChunk & EvidenceExcerpt & {
  evidenceId: string
  embeddingText: string
  maskedText: string
  partialAtStart: boolean
  partialAtEnd: boolean
  fields: Fields
}
type RankedPassage = { rank: number; passage: Passage }
type PassageScore = { chunkIndex: number; score: number }
type SentenceHit = { evidenceId: string; score: number; primary: Passage; alternatives: Passage[]; fields?: Fields }

function fieldMatch(query: Fields, candidate: Fields) {
  const hasOverlap = (left: Set<string>, right: Set<string>) => [...left].some(value => right.has(value))
  return (hasOverlap(query.amounts, candidate.amounts) ? 0.008 : 0)
    + (hasOverlap(query.dates, candidate.dates) ? 0.008 : 0)
}

function takeDistinct<T>(lists: T[][], limit: number) {
  const result = new Set<T>()
  for (let offset = 0; result.size < limit && lists.some(list => offset < list.length); offset++) {
    for (const list of lists) {
      if (offset < list.length) result.add(list[offset])
      if (result.size === limit) break
    }
  }
  return result
}

function buildPassages(document: EvidenceDocument, prepareText: (text: string) => string) {
  const source = document.fragments.map(fragment => fragment.text).join('\n')
  const masked = prepareText(source)
  const name = prepareText(document.name)
  let fragmentStart = 0
  return document.fragments.flatMap(fragment => {
    const start = fragmentStart
    fragmentStart += fragment.text.length + 1
    let cursor = 0
    return buildEvidenceChunks(fragment.text).map(chunk => {
      const offset = fragment.text.indexOf(chunk.content, cursor)
      if (offset >= 0) cursor = offset + chunk.content.length
      // 同长度脱敏后再映射块边界，覆盖恰好被切在两块之间的敏感信息。
      const mapped = offset >= 0 && masked.length === source.length
      const maskedText = mapped ? masked.slice(start + offset, start + cursor) : '＊'.repeat(chunk.content.length)
      return {
        ...chunk, evidenceId: document.id, text: chunk.content,
        content: `${document.name}\n${chunk.content}`, embeddingText: `${name}\n${maskedText}`, maskedText,
        partialAtStart: !mapped || masked[start + offset - 1] === '＊',
        partialAtEnd: !mapped || masked[start + cursor] === '＊',
        locator: chunk.page ? `第 ${chunk.page} 页` : fragment.locator,
        fields: extractFields(chunk.content),
      }
    })
  })
}

function reciprocalRanks(rows: PassageScore[], passages: Passage[]) {
  const best = new Map<string, RankedPassage>()
  let previousScore: number | undefined
  let rank = 0
  for (const { chunkIndex, score } of rows) {
    const passage = passages[chunkIndex]
    if (score <= 0 || best.has(passage.evidenceId)) continue
    if (score !== previousScore) rank = best.size + 1
    previousScore = score
    best.set(passage.evidenceId, { rank: 1 / (RANK_FUSION_CONSTANT + rank), passage })
  }
  return best
}

function vectorLength(vector: ArrayLike<number>) {
  let squaredLength = 0
  for (let i = 0; i < vector.length; i++) squaredLength += vector[i] * vector[i]
  return Math.sqrt(squaredLength)
}

function cosine(left: ArrayLike<number>, right: ArrayLike<number>, scale: number) {
  if (left.length !== right.length || !scale) return 0
  let dot = 0
  for (let i = 0; i < left.length; i++) dot += left[i] * right[i]
  return dot / scale
}

function trimSensitiveEdges(passage: Passage, text: string) {
  let start = passage.text.indexOf(text)
  if (start < 0) return ''
  let end = start + text.length
  const masked = passage.maskedText
  const partialStart = start === 0 ? passage.partialAtStart : masked[start - 1] === '＊'
  const partialEnd = end === masked.length ? passage.partialAtEnd : masked[end] === '＊'
  if (partialStart) while (start < end && masked[start] === '＊') start++
  if (partialEnd) while (end > start && masked[end - 1] === '＊') end--
  return passage.text.slice(start, end).trim()
}

function focusedExcerpt(passage: Passage, query: string, fields?: Fields): EvidenceExcerpt {
  if (passage.text.length <= 240) return { locator: passage.locator, text: trimSensitiveEdges(passage, passage.text) }
  const chunks = buildEvidenceChunks(passage.text, { targetChars: 180, maxChars: 240 })
  const ranked = rankEvidenceChunks(buildEvidenceChunkIndex(chunks), [query])
  let best = chunks[ranked[0]?.chunkIndex ?? 0]?.content ?? passage.text.slice(0, 240)
  if (fields) {
    let highest = fieldMatch(fields, extractFields(best))
    for (const chunk of chunks) {
      const score = fieldMatch(fields, extractFields(chunk.content))
      if (score <= highest) continue
      highest = score
      best = chunk.content
    }
    if (!highest) best = passage.text
  }
  return { locator: passage.locator, text: trimSensitiveEdges(passage, best) }
}

export async function rankLinkageEvidence(
  paragraphs: RankingParagraph[],
  documents: EvidenceDocument[],
  embeddings?: EmbeddingOptions,
  signal?: AbortSignal,
) {
  const candidatesByParagraph = new Map<string, EvidenceCandidate[]>()
  signal?.throwIfAborted()
  const orderedParagraphs = paragraphs.map(paragraph => ({ ...paragraph, sentences: [...paragraph.sentences]
    .sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high')) }))
  const inputs = orderedParagraphs.map(paragraph => paragraph.sentences.map(item => item.sentenceText))
  const queries = [...new Set(inputs.flat())]
  if (!queries.length || !documents.length) return candidatesByParagraph

  const passagesByEvidence = new Map<string, Passage[]>()
  const passages = documents.flatMap(document => buildPassages(document, embeddings?.prepareText ?? (text => text)))
  if (!passages.length) return candidatesByParagraph
  passages.forEach((passage, index) => {
    passage.index = index
    const list = passagesByEvidence.get(passage.evidenceId) ?? []
    list.push(passage)
    passagesByEvidence.set(passage.evidenceId, list)
  })
  const index = buildEvidenceChunkIndex(passages)

  let densePassages: Array<{ chunkIndex: number; vector: ArrayLike<number>; length: number }> = []
  const queryVectors = new Map<string, { vector: ArrayLike<number>; length: number }>()
  if (embeddings?.embedQueries && embeddings.embedPassages) {
    const selectedQueries = embeddings.maxQueries !== undefined && embeddings.maxQueries < queries.length
      ? [...takeDistinct(inputs, embeddings.maxQueries)]
      : queries
    const limit = embeddings.maxPassages ?? passages.length
    const selected = limit < passages.length
      ? takeDistinct(selectedQueries.map(query => rankEvidenceChunks(index, [query]).slice(0, limit).map(row => row.chunkIndex)), limit)
      : new Set<number>()
    if (selected.size < limit && limit < passages.length) {
      const materialPassages = [...passagesByEvidence.values()].map(list => list.map(passage => passage.index))
      for (const chunkIndex of takeDistinct(materialPassages, limit)) {
        if (selected.size >= limit) break
        selected.add(chunkIndex)
      }
    }
    const chunkIndexes = limit < passages.length ? [...selected] : passages.map(passage => passage.index)
    const prepare = embeddings.prepareText ?? (text => text)
    const controller = new AbortController()
    const embeddingSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const [evidenceVectors, sentenceVectors] = await Promise.all([
        embeddings.embedPassages(chunkIndexes.map(chunkIndex => passages[chunkIndex].embeddingText), embeddingSignal),
        embeddings.embedQueries(selectedQueries.map(query => prepare(query).slice(0, 1600)), embeddingSignal),
      ])
      if (evidenceVectors.length === chunkIndexes.length && sentenceVectors.length === selectedQueries.length) {
        densePassages = evidenceVectors.map((vector, i) => ({ chunkIndex: chunkIndexes[i], vector, length: vectorLength(vector) }))
        sentenceVectors.forEach((vector, i) => queryVectors.set(selectedQueries[i], { vector, length: vectorLength(vector) }))
      }
    } catch {
      controller.abort()
      signal?.throwIfAborted()
      // 向量服务不可用时继续使用 BM25 和精确字段匹配。
    }
  }
  signal?.throwIfAborted()

  const rankings = new Map<string, SentenceHit[]>()
  for (const [queryIndex, query] of queries.entries()) {
    if (signal && queryIndex % 8 === 0) await setImmediate(undefined, { signal })
    const keyword = reciprocalRanks(rankEvidenceChunks(index, [query]), passages)
    const semanticQuery = queryVectors.get(query)
    const bestSemantic = new Map<string, PassageScore>()
    if (semanticQuery) for (const { chunkIndex, vector, length } of densePassages) {
      const score = cosine(semanticQuery.vector, vector, semanticQuery.length * length)
      const evidenceId = passages[chunkIndex].evidenceId
      if (score > (bestSemantic.get(evidenceId)?.score ?? 0)) bestSemantic.set(evidenceId, { chunkIndex, score })
    }
    const semantic = reciprocalRanks([...bestSemantic.values()].sort((left, right) =>
      right.score - left.score || left.chunkIndex - right.chunkIndex), passages)
    const queryFields = extractFields(query)
    const numbers = new Set(query.normalize('NFKC').toUpperCase().match(/\bE\d+\b/gu) ?? [])

    const ranked = documents.flatMap(document => {
      const materialPassages = passagesByEvidence.get(document.id)
      if (!materialPassages?.length) return []
      const keywordHit = keyword.get(document.id)
      const semanticHit = semantic.get(document.id)
      let fieldScore = 0
      let fieldPassage: Passage | undefined
      for (const passage of materialPassages) {
        const score = fieldMatch(queryFields, passage.fields)
        if (score <= fieldScore) continue
        fieldScore = score
        fieldPassage = passage
      }
      const numberScore = numbers.has(document.number.normalize('NFKC').toUpperCase()) ? 0.035 : 0
      const score = ((keywordHit?.rank ?? 0) + (semanticHit?.rank ?? 0)) / (semantic.size ? 2 : 1) + fieldScore + numberScore
      if (!score) return []
      const primary = fieldPassage ?? keywordHit?.passage ?? semanticHit?.passage ?? materialPassages[0]
      const alternatives = [keywordHit?.passage, semanticHit?.passage]
        .filter((passage): passage is Passage => passage !== undefined && passage !== primary)
      return [{ evidenceId: document.id, score, primary, alternatives, fields: fieldPassage ? queryFields : undefined }]
    }).sort((left, right) => right.score - left.score).slice(0, CANDIDATES_PER_PARAGRAPH)
    rankings.set(query, ranked)
  }

  for (const paragraph of orderedParagraphs) {
    const candidates = new Map<string, EvidenceCandidate>()
    const alternateExcerpts = new Map<string, EvidenceExcerpt[]>()
    // 每轮从每个待核验句取一份候选，避免一个句子的高分材料占满段落预算。
    for (let rank = 0; rank < CANDIDATES_PER_PARAGRAPH; rank++) {
      for (const sentence of paragraph.sentences) {
        const hit = rankings.get(sentence.sentenceText)?.[rank]
        if (!hit) continue
        const candidate = candidates.get(hit.evidenceId) ?? { evidenceId: hit.evidenceId, sentenceIndexes: [], fragments: [] }
        if (!candidates.has(hit.evidenceId) && candidates.size === CANDIDATES_PER_PARAGRAPH) continue
        const excerpt = focusedExcerpt(hit.primary, sentence.sentenceText, hit.fields)
        const alreadyShown = candidate.fragments.some(item => item.locator === excerpt.locator && item.text === excerpt.text)
        if (excerpt.text && (alreadyShown || candidate.fragments.length < EXCERPTS_PER_MATERIAL)) {
          if (!alreadyShown) candidate.fragments.push(excerpt)
          candidate.sentenceIndexes.push(sentence.sentenceIndex)
        }
        if (hit.alternatives.length && candidate.fragments.length < EXCERPTS_PER_MATERIAL) {
          const alternatives = alternateExcerpts.get(hit.evidenceId) ?? []
          alternatives.push(...hit.alternatives.map(passage => focusedExcerpt(passage, sentence.sentenceText)))
          alternateExcerpts.set(hit.evidenceId, alternatives)
        }
        candidates.set(hit.evidenceId, candidate)
      }
    }
    for (const candidate of candidates.values()) for (const excerpt of alternateExcerpts.get(candidate.evidenceId) ?? []) {
      if (candidate.fragments.length >= EXCERPTS_PER_MATERIAL) break
      if (!excerpt.text || candidate.fragments.some(item => item.locator === excerpt.locator && item.text === excerpt.text)) continue
      candidate.fragments.push(excerpt)
    }
    candidatesByParagraph.set(paragraph.id, [...candidates.values()])
  }
  return candidatesByParagraph
}
