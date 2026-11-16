import { copyFile, mkdir, mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '../core/app-error.js'
import { env } from '../config/env.js'
import { getMineruPool, parserRoot } from './mineru-runtime.js'

export interface ParsedDocumentBlock {
  page: number
  bbox: number[]
  coordinateSpace: string
  text: string
  locator?: string
}

export interface ParsedArtifact {
  schemaVersion: number
  engineVersion: string
  text: string
  html?: string
  pages: number
  blocks: ParsedDocumentBlock[]
  layout?: { pages: number; blocks: ParsedDocumentBlock[] }
  warnings: string[]
  reviewRequired: boolean
  chat?: { title: string; group?: boolean; messages: Array<{ sender: string; text: string; bbox: number[]; time_context?: string; display_name?: string }> }
}

export function supportsDocumentParsing(fileName: string, mimeType = '') {
  return /\.(docx?|rtf|pdf|png|jpe?g|webp|bmp|tiff?|txt|md|markdown|csv|tsv|json|log|gif)$/i.test(fileName)
    || /^text\//i.test(mimeType) || /^application\/rtf$/i.test(mimeType)
}

export async function readParsedArtifact(location: string): Promise<ParsedArtifact> {
  if ((await stat(location)).size > 64 * 1024 ** 2) throw new Error('解析结果过大')
  const result = JSON.parse(await readFile(location, 'utf8')) as ParsedArtifact
  if (result.schemaVersion !== 1 || typeof result.text !== 'string'
    || (result.html !== undefined && typeof result.html !== 'string')
    || result.text.length + (result.html?.length ?? 0) > 8_000_000
    || !Array.isArray(result.blocks) || !Array.isArray(result.warnings)) throw new Error('解析结果格式无效')
  return result
}

export function documentText(result: ParsedArtifact) {
  return (result.html ? result.blocks.map(block => block.text).join('\n\n') : result.text).trim()
}

export async function runDocumentParsing(inputPath: string, outputPath: string, fileName: string, mimeType?: string, mode?: string) {
  await getMineruPool().run({ action: 'parse', inputPath, outputPath, fileName, mimeType, mode })
  return readParsedArtifact(outputPath)
}

export async function parseDocument(source: Buffer | string, fileName: string, mimeType?: string) {
  if (!supportsDocumentParsing(fileName, mimeType)) {
    throw new AppError('当前文件格式尚未接入解析。', 415, 'DOCUMENT_FORMAT_UNSUPPORTED')
  }
  const size = typeof source === 'string' ? (await stat(source)).size : source.length
  if (size > env.MAX_EVIDENCE_FILE_MB * 1024 ** 2) {
    throw new AppError('文件超过解析大小上限。', 413, 'DOCUMENT_TOO_LARGE')
  }
  const root = parserRoot()
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(path.join(root, 'document-'))
  const output = path.join(directory, 'result.json')
  const suffix = path.extname(fileName).replace(/[^.a-z0-9]/gi, '').toLowerCase()
  const staged = typeof source === 'string' && path.extname(source).toLowerCase() === suffix
    ? undefined : path.join(directory, 'source' + suffix)
  try {
    let input: string
    if (typeof source === 'string') {
      if (staged) await copyFile(source, staged)
      input = staged ?? source
    } else {
      input = staged!
      await writeFile(input, source)
    }
    return await runDocumentParsing(input, output, fileName, mimeType)
  } finally {
    await Promise.allSettled([output, ...(staged ? [staged] : [])].map(file => unlink(file)))
    await rmdir(directory).catch(() => undefined)
  }
}
