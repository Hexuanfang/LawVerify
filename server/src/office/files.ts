import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { AppError } from '../core/app-error.js'
import { getOfficeStorageDirectory, getWorkspaceDataDir } from '../config/paths.js'
import type { Certificate, CertificateParagraph } from '../domain.js'
import { OFFICE_FILE_ID } from '../infrastructure/workspace-case-files.js'
import { getCurrentWorkspaceAccount, rememberCaseFile } from '../store.js'
import { patchOfficeDocx, readOfficeDocxBlocks } from './patch.js'
import { markdownBlocks, patchMarkdown } from './markdown.js'

export type OfficeFile = NonNullable<Certificate['officeFile']>
export type OfficeFormat = OfficeFile['format']
export const MAX_OFFICE_BYTES = 20 * 1024 * 1024
export const NO_OFFICE_FILE_VERSION = 'none'

export function officeFormat(fileName: string): OfficeFormat {
  if (!fileName || /[\\/\u0000-\u001f]/u.test(fileName))
    throw new AppError('文书文件名不正确。', 400, 'OFFICE_FILE_NAME')
  const suffix = path.extname(fileName).slice(1).toLowerCase()
  if (suffix !== 'doc' && suffix !== 'docx' && suffix !== 'txt' && suffix !== 'md' && suffix !== 'markdown')
    throw new AppError('文书支持 Word（.doc、.docx）、TXT 或 Markdown（.md、.markdown）。', 400, 'OFFICE_FORMAT')
  return suffix
}

export function officeHash(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function officeContentHash(paragraphs: Array<Pick<CertificateParagraph, 'id' | 'text' | 'richText'>>) {
  return officeHash(JSON.stringify(paragraphs.map(({ id, text, richText }) => ({ id, text, richText }))))
}

export function officeRoot() {
  return path.join(getWorkspaceDataDir(), getOfficeStorageDirectory(getCurrentWorkspaceAccount()))
}

export function officePath(id: string, suffix: 'bin' | 'json' = 'bin') {
  if (!OFFICE_FILE_ID.test(id)) throw new AppError('文书文件标识不正确。', 400, 'OFFICE_ID')
  return path.join(officeRoot(), `${id}.${suffix}`)
}

export async function atomicOfficeJson(id: string, value: unknown) {
  await mkdir(officeRoot(), { recursive: true })
  const target = officePath(id, 'json')
  const temporary = `${target}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function storeOfficeFile(caseId: string, bytes: Buffer, fileName: string, version = 1): Promise<OfficeFile> {
  const format = officeFormat(fileName)
  if (bytes.length > MAX_OFFICE_BYTES) throw new AppError('文书超过 20 MB。', 413, 'OFFICE_TOO_LARGE')
  const id = randomUUID()
  rememberCaseFile(caseId, `office:${id}`)
  await mkdir(officeRoot(), { recursive: true })
  await writeFile(officePath(id), bytes, { flag: 'wx', mode: 0o600 })
  return { id, fileName, format, version, sha256: officeHash(bytes), contentHash: '', updatedAt: new Date().toISOString() }
}

export async function parseOfficeBytes(bytes: Buffer, format: Exclude<OfficeFormat, 'doc'>, preserveTableCells = false) {
  if (bytes.length > MAX_OFFICE_BYTES) throw new AppError('文书超过 20 MB。', 413, 'OFFICE_TOO_LARGE')
  if (format !== 'docx') {
    const label = format === 'txt' ? 'TXT' : 'Markdown'
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new AppError(`${label} 文书需要 UTF-8 编码，请转换编码后重试。`, 422, 'OFFICE_TEXT_ENCODING') }
    if (text.includes('\0')) throw new AppError(`${label} 包含二进制数据。`, 422, 'OFFICE_INVALID_TEXT')
    const paragraphs = format === 'txt' ? undefined : markdownBlocks(text.replace(/\r\n?/gu, '\n'))
      .map(({ text, richText }) => ({ text, richText }))
    return { text, html: '', paragraphs }
  }
  try {
    // 按 OOXML 提取段落、制表符与软换行，原 DOCX 文件负责保留排版。
    const paragraphs = await readOfficeDocxBlocks(bytes, preserveTableCells)
    return { text: paragraphs.map(item => item.text).join('\n\n'), html: '', paragraphs: preserveTableCells ? paragraphs : undefined }
  } catch {
    throw new AppError('Word 文件无法读取，请检查文件是否损坏或加密。', 422, 'OFFICE_INVALID_DOCX')
  }
}

export function officeDocxBytes(paragraphs: Array<{ text: string }>) {
  const children = paragraphs.map(paragraph => new Paragraph({
    children: paragraph.text.split('\n').map((text, index) => new TextRun({ text, break: index ? 1 : undefined })),
  }))
  return Packer.toBuffer(new Document({ sections: [{ children }] }))
}

async function patchOfficeFile(certificate: Certificate, file: OfficeFile) {
  let snapshot: { paragraphs: CertificateParagraph[] }
  try { snapshot = JSON.parse(await readFile(officePath(file.id, 'json'), 'utf8')) }
  catch { throw new AppError('原文书文件缺少正文基线，请重新导入原件。', 409, 'OFFICE_BASE_MISSING') }
  const original = await readFile(officePath(file.id))
  if (file.format === 'docx') return patchOfficeDocx(original, snapshot.paragraphs, certificate.paragraphs)
  const text = original.toString('utf8')
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  return Buffer.from(bom + patchMarkdown(text.slice(bom.length), snapshot.paragraphs, certificate.paragraphs), 'utf8')
}

export async function readDocxEditSource(certificate: Certificate) {
  const file = certificate.officeFile
  if (file?.format !== 'docx') throw new AppError('此文书没有可读取的 DOCX 编辑副本。', 404, 'OFFICE_EDIT_SOURCE_UNAVAILABLE')
  const bytes = file.contentHash === officeContentHash(certificate.paragraphs)
    ? await readFile(officePath(file.id))
    : await patchOfficeFile(certificate, file)
  return { bytes, file }
}

export async function storeOfficeVersion(certificate: Certificate, bytes: Buffer, fileName: string) {
  const file = await storeOfficeFile(certificate.caseId, bytes, fileName, (certificate.officeFile?.version ?? 0) + 1)
  file.contentHash = officeContentHash(certificate.paragraphs)
  await atomicOfficeJson(file.id, { paragraphs: certificate.paragraphs })
  return file
}

export function officeVersionFileName(certificate: Certificate, format: 'docx' | 'txt') {
  const name = (certificate.officeFile?.fileName ?? certificate.title)
    .replace(/\.(docx?|txt)$/i, '').replace(/[\\/\u0000-\u001f]/gu, '_')
  return `${name || '文书'}.${format}`
}

export async function legacyOfficeBytes(certificate: Certificate): Promise<{ bytes: Buffer; fileName: string; file?: OfficeFile }> {
  const file = certificate.officeFile
  if (file && file.contentHash === officeContentHash(certificate.paragraphs))
    return { bytes: await readFile(officePath(file.id)), fileName: file.fileName, file }
  if (file?.format === 'docx' || file?.format === 'md' || file?.format === 'markdown') {
    const bytes = await patchOfficeFile(certificate, file)
    return { bytes, fileName: file.fileName, file: await storeOfficeVersion(certificate, bytes, file.fileName) }
  }
  const bytes = file?.format === 'txt'
    ? Buffer.from(certificate.paragraphs.map(paragraph => paragraph.text).join('\n\n'), 'utf8')
    : await officeDocxBytes(certificate.paragraphs)
  const format = file?.format === 'txt' ? 'txt' : 'docx'
  const fileName = officeVersionFileName(certificate, format)
  if (!file) {
    if (bytes.length > MAX_OFFICE_BYTES) throw new AppError('文书超过 20 MB。', 413, 'OFFICE_TOO_LARGE')
    return { bytes, fileName }
  }
  return { bytes, fileName, file: await storeOfficeVersion(certificate, bytes, fileName) }
}
