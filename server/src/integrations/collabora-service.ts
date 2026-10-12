import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import { env } from '../config/env.js'
import { getStorageRoot } from '../config/paths.js'
import { AppError } from '../core/app-error.js'
import { readWorkspace } from '../store.js'

interface WopiClaims {
  fileId: string
  purpose: 'collabora-wopi'
}

interface CollaboraSessionOptions {
  appBaseUrl?: string
  collaboraBaseUrl?: string
}

function sanitizeFileName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').trim() || 'certificate'
}

function getFileId(certificateId: string) {
  return `certificate-${certificateId}`
}

function getStorageDir() {
  return path.join(getStorageRoot(), 'collabora')
}

function getFilePath(certificateId: string) {
  return path.join(getStorageDir(), `${getFileId(certificateId)}.docx`)
}

function getWopiToken(fileId: string) {
  return jwt.sign(
    {
      fileId,
      purpose: 'collabora-wopi',
    } satisfies WopiClaims,
    env.JWT_SECRET,
    { expiresIn: '2h' },
  )
}

export function isCollaboraEnabled() {
  return Boolean(env.COLLABORA_PUBLIC_URL)
}

export function verifyWopiAccessToken(token: string, fileId: string) {
  try {
    const claims = jwt.verify(token, env.JWT_SECRET) as WopiClaims
    return claims.purpose === 'collabora-wopi' && claims.fileId === fileId
  } catch {
    return false
  }
}

export async function ensureCertificateDocument(certificateId: string) {
  const workspace = await readWorkspace()
  const certificate = workspace.certificates.find((item) => item.id === certificateId)

  if (!certificate) {
    throw new AppError('质证书不存在。', 404, 'CERTIFICATE_NOT_FOUND')
  }

  const caseFolder = workspace.cases.find((item) => item.id === certificate.caseId)
  const fileId = getFileId(certificateId)
  const fileName = `${sanitizeFileName(certificate.title)}.docx`
  const fullPath = getFilePath(certificateId)

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            spacing: { after: 240 },
            children: [new TextRun(certificate.title)],
          }),
          new Paragraph({
            spacing: { after: 120 },
            children: [
              new TextRun(`案件：${caseFolder?.name ?? '未命名案件'}`),
            ],
          }),
          new Paragraph({
            spacing: { after: 120 },
            children: [
              new TextRun(`生成时间：${new Date(certificate.createdAt).toLocaleString('zh-CN', { hour12: false })}`),
            ],
          }),
          new Paragraph({
            spacing: { after: 240 },
            children: [
              new TextRun(`生成角色：${certificate.role === 'plaintiff' ? '原告质证' : '被告质证'}`),
            ],
          }),
          ...certificate.paragraphs.flatMap((paragraph, index) => [
            new Paragraph({
              spacing: { before: 120, after: 80 },
              children: [
                new TextRun({
                  text: `第 ${index + 1} 段`,
                  bold: true,
                }),
              ],
            }),
            new Paragraph({
              spacing: { after: 160 },
              children: [new TextRun(paragraph.text)],
            }),
          ]),
        ],
      },
    ],
  })

  const buffer = await Packer.toBuffer(doc)
  await mkdir(getStorageDir(), { recursive: true })
  await writeFile(fullPath, buffer)
  const fileStat = await stat(fullPath)

  return {
    fileId,
    certificateId,
    fileName,
    fullPath,
    size: fileStat.size,
    version: String(fileStat.mtimeMs),
  }
}

async function ensureCertificateDocumentIfMissing(certificateId: string) {
  const fullPath = getFilePath(certificateId)

  try {
    await access(fullPath)
  } catch {
    await ensureCertificateDocument(certificateId)
  }
}

export async function getCollaboraSession(certificateId: string, options: CollaboraSessionOptions = {}) {
  if (!isCollaboraEnabled()) {
    return {
      enabled: false,
      reason: '未配置 COLLABORA_PUBLIC_URL，尚未部署真实 Collabora Online 服务。',
    }
  }

  await ensureCertificateDocumentIfMissing(certificateId)
  const document = await getWopiFileInfo(getFileId(certificateId))
  const token = getWopiToken(document.fileId)
  const appBaseUrl = (options.appBaseUrl ?? env.APP_PUBLIC_BASE_URL).replace(/\/$/, '')
  const baseUrl = (options.collaboraBaseUrl ?? env.COLLABORA_PUBLIC_URL!).replace(/\/$/, '')
  const wopiSrc = `${appBaseUrl}${env.API_V1_PREFIX}/wopi/files/${encodeURIComponent(document.fileId)}`
  const editorUrl = `${baseUrl}/browser/dist/cool.html?WOPISrc=${encodeURIComponent(wopiSrc)}&access_token=${encodeURIComponent(token)}&lang=zh-CN`

  return {
    enabled: true,
    fileId: document.fileId,
    fileName: document.fileName,
    wopiSrc,
    accessToken: token,
    editorUrl,
    mode: env.COLLABORA_WOPI_ALLOW_EDIT ? 'edit' : 'readonly',
  }
}

export async function getWopiFileInfo(fileId: string) {
  if (!fileId.startsWith('certificate-')) {
    throw new AppError('不支持的 WOPI 文件。', 404, 'WOPI_FILE_NOT_FOUND')
  }

  const certificateId = fileId.replace(/^certificate-/, '')
  const workspace = await readWorkspace()
  const certificate = workspace.certificates.find((item) => item.id === certificateId)

  if (!certificate) {
    throw new AppError('质证书不存在。', 404, 'CERTIFICATE_NOT_FOUND')
  }

  await ensureCertificateDocumentIfMissing(certificateId)

  const fullPath = getFilePath(certificateId)
  const fileStat = await stat(fullPath)

  return {
    fileId,
    certificateId,
    fileName: `${sanitizeFileName(certificate.title)}.docx`,
    fullPath,
    size: fileStat.size,
    version: String(fileStat.mtimeMs),
  }
}

export async function readWopiFileContents(fileId: string) {
  const info = await getWopiFileInfo(fileId)
  return readFile(info.fullPath)
}

export async function writeWopiFileContents(fileId: string, contents: Buffer) {
  const info = await getWopiFileInfo(fileId)
  await writeFile(info.fullPath, contents)
  const fileStat = await stat(info.fullPath)
  return {
    ...info,
    size: fileStat.size,
    version: String(fileStat.mtimeMs),
  }
}
