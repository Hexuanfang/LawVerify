import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ParsedArtifact } from './document-jobs.js'

const segmentPages = 20
const maxPages = 1000
const maxArtifactBytes = 64 * 1024 ** 2

interface PdfInfo {
  pdfPages: number
  engineVersion: string
}

interface Range {
  first: number
  last: number
  artifact?: ParsedArtifact
}

interface Progress extends PdfInfo {
  ranges: Range[]
}

interface Options {
  directory: string
  input: Record<string, unknown> & { outputPath: string }
  checkpoint?: string
  signal: AbortSignal
  run(input: Record<string, unknown>): Promise<unknown>
  readArtifact(file: string): Promise<ParsedArtifact>
}

function isPdfInfo(value: unknown): value is PdfInfo {
  const info = value as Partial<PdfInfo> | undefined
  return !!info && Number.isInteger(info.pdfPages) && info.pdfPages! >= 1 && info.pdfPages! <= maxPages
    && typeof info.engineVersion === 'string'
}

function isRangeArtifact(artifact: ParsedArtifact, range: Range, engineVersion: string) {
  return artifact.schemaVersion === 1 && artifact.engineVersion === engineVersion && typeof artifact.text === 'string'
    && artifact.pages === range.last - range.first + 1 && Array.isArray(artifact.warnings) && Array.isArray(artifact.blocks)
    && artifact.warnings.every(warning => typeof warning === 'string')
    && artifact.blocks.every(block => block && Number.isInteger(block.page) && block.page >= 1 && block.page <= artifact.pages
      && (block.locator === undefined || typeof block.locator === 'string'))
}

async function readProgress(file: string): Promise<Progress | undefined> {
  try {
    if ((await stat(file)).size > maxArtifactBytes) return
    const progress = JSON.parse(await readFile(file, 'utf8')) as Progress
    if (!isPdfInfo(progress) || !Array.isArray(progress.ranges)) return
    let next = 1
    for (const range of progress.ranges) {
      if (!range || range.first !== next || !Number.isInteger(range.last) || range.last < next
        || range.last - next >= segmentPages || range.last > progress.pdfPages
        || (range.artifact !== undefined && (!range.artifact || !isRangeArtifact(range.artifact, range, progress.engineVersion)))) return
      next = range.last + 1
    }
    if (next === progress.pdfPages + 1) return progress
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
}

function newProgress(info: PdfInfo, pagesPerSegment: number): Progress {
  const ranges: Range[] = []
  for (let first = 1; first <= info.pdfPages; first += pagesPerSegment) {
    ranges.push({ first, last: Math.min(first + pagesPerSegment - 1, info.pdfPages) })
  }
  return { ...info, ranges }
}

function memoryLimit(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'PARSER_MEMORY_LIMIT'
}

function tooLarge() {
  return Object.assign(new Error('解析结果过大。'), { code: 'PARSER_RESULT_TOO_LARGE' })
}

async function writeJson(file: string, value: unknown) {
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > maxArtifactBytes) throw tooLarge()
  await writeFile(file, serialized, { flush: true })
}

function merge(progress: Progress): ParsedArtifact {
  const parts: string[] = []
  const result: ParsedArtifact = { schemaVersion: 1, engineVersion: progress.engineVersion, pages: progress.pdfPages,
    text: '', blocks: [], warnings: [], reviewRequired: false }
  for (const { first, artifact } of progress.ranges) {
    const offset = first - 1
    const segment = artifact!
    parts.push(segment.text)
    for (const block of segment.blocks) {
      result.blocks.push({ ...block, page: block.page + offset })
    }
    result.warnings.push(...segment.warnings)
    result.reviewRequired ||= segment.reviewRequired
  }
  result.text = parts.filter(Boolean).join('\n\n')
  if (result.text.length > 8_000_000) throw tooLarge()
  return result
}

export async function parsePdfOnDisk({ directory, input, checkpoint, signal, run, readArtifact }: Options) {
  const submit = (job: Record<string, unknown>) => {
    signal.throwIfAborted()
    return run(job)
  }
  const inspect = async () => {
    const info = await submit({ ...input, action: 'pdf-info' })
    if (!isPdfInfo(info)) throw new Error('PDF 页数信息无效。')
    return info
  }
  const diskProgress = checkpoint ?? path.join(directory, 'pdf-progress.json')
  let progress = await readProgress(diskProgress)
  let fullMemoryLimit = false
  let info: PdfInfo
  if (progress) {
    info = await inspect()
  } else {
    try {
      let result = await submit({ ...input, pdfWhole: 'auto' })
      if (!isPdfInfo(result)) return
      result = await submit({ ...input, pdfWhole: 'prefer' })
      if (!isPdfInfo(result)) return
      info = result
    } catch (error) {
      if (!memoryLimit(error)) throw error
      fullMemoryLimit = true
      info = await inspect()
    }
  }
  if (fullMemoryLimit && info.pdfPages === 1) {
    throw Object.assign(new Error('第 1 页解析达到本机内存上限。'), { code: 'PARSER_MEMORY_LIMIT' })
  }
  if (progress?.pdfPages !== info.pdfPages || progress.engineVersion !== info.engineVersion) {
    const initialSize = fullMemoryLimit && info.pdfPages <= segmentPages ? Math.floor(info.pdfPages / 2) : segmentPages
    progress = newProgress(info, initialSize)
  }
  const partFile = path.join(directory, 'pdf-segment.json')
  const stage = path.join(directory, 'pdf-progress.tmp')
  for (let index = 0; index < progress.ranges.length;) {
    signal.throwIfAborted()
    const range = progress.ranges[index]
    if (range.artifact) {
      index++
      continue
    }
    try {
      await submit({ ...input, batchSize: undefined, outputPath: partFile, pdfScope: directory,
        pdfRange: [range.first, range.last] })
      signal.throwIfAborted()
      const artifact = await readArtifact(partFile)
      if (!isRangeArtifact(artifact, range, info.engineVersion)) throw new Error('PDF 分段结果页码无效。')
      range.artifact = artifact
      index++
    } catch (error) {
      signal.throwIfAborted()
      if (!memoryLimit(error)) throw error
      if (range.first === range.last) {
        throw Object.assign(new Error(`第 ${range.first} 页解析达到本机内存上限。`), { code: 'PARSER_MEMORY_LIMIT' })
      }
      const mid = Math.floor((range.first + range.last) / 2)
      progress.ranges.splice(index, 1, { first: range.first, last: mid }, { first: mid + 1, last: range.last })
    }
    await writeJson(stage, progress)
    await rename(stage, diskProgress)
  }
  signal.throwIfAborted()
  await writeJson(input.outputPath, merge(progress))
}
