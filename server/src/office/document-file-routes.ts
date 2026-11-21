import { Router } from 'express'
import multer from 'multer'
import { readFile, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { AppError } from '../core/app-error.js'
import { documentText, parseDocument } from '../infrastructure/document-jobs.js'
import { runExclusiveWorkspaceMutation } from '../infrastructure/workspace-lock.js'
import { boundedFileStorage, reserveUpload } from '../middleware/bounded-upload.js'
import { importCertificate, sanitizeWorkspaceForClient } from '../service.js'
import { readWorkspace, writeWorkspace } from '../store.js'
import { legacyOfficeBytes, MAX_OFFICE_BYTES, officeFormat, parseOfficeBytes, storeOfficeFile } from './files.js'

function normalizedFileName(name: string) {
  // multipart 的浏览器文件名可能按 latin1 解码。
  if ([...name].some(char => char.charCodeAt(0) > 255)) return name
  const decoded = Buffer.from(name, 'latin1').toString('utf8')
  return decoded.includes('\uFFFD') ? name : decoded
}

export function createDocumentFileRouter() {
  const router = Router()
  const upload = multer({
    storage: boundedFileStorage(), limits: { fileSize: MAX_OFFICE_BYTES, files: 1, fields: 2 },
    fileFilter: (_request, file, callback) => {
      try { officeFormat(normalizedFileName(file.originalname)); callback(null, true) }
      catch (error) { callback(error as Error) }
    },
  })
  router.post('/import', reserveUpload, upload.single('file'), async (request, response) => {
    const file = request.file
    if (!file) throw new AppError('请选择 Word、TXT 或 Markdown 文书。', 400, 'DOCUMENT_REQUIRED')
    try {
      const caseId = z.string().min(1).parse(request.body.caseId)
      const docKey = z.string().max(16).optional().parse(request.body.docKey)
      const name = normalizedFileName(file.originalname)
      const format = officeFormat(name)
      const bytes = await readFile(file.path)
      let content: string
      let paragraphs: Awaited<ReturnType<typeof parseOfficeBytes>>['paragraphs']
      if (format === 'doc') {
        const parsed = await parseDocument(file.path, name, file.mimetype)
        content = documentText(parsed)
        if (parsed.reviewRequired) throw new AppError(parsed.warnings[0] ?? '请检查旧版 Word 文书。', 422, 'DOCUMENT_REVIEW_REQUIRED')
      } else {
        const parsed = await parseOfficeBytes(bytes, format, docKey === 'zj')
        content = parsed.text
        paragraphs = parsed.paragraphs
      }
      if (!content.trim()) throw new AppError('文书没有可读取的正文。', 422, 'DOCUMENT_EMPTY_IMPORT')
      const imported = await runExclusiveWorkspaceMutation(async () => {
        await readWorkspace()
        const documentFile = await storeOfficeFile(caseId, bytes, name)
        return importCertificate({
          caseId, title: name.replace(/\.[^.]+$/, ''), sourceFileName: name, docKey, content, paragraphs,
        }, { trustedTableCells: true, documentFile })
      })
      response.json({ ...imported, workspace: sanitizeWorkspaceForClient(imported.workspace) })
    } finally { await unlink(file.path).catch(() => undefined) }
  })
  router.get('/:id/download', async (request, response) => {
    const { bytes, file } = await runExclusiveWorkspaceMutation(async () => {
      const workspace = await readWorkspace()
      const certificate = workspace.certificates.find(item => item.id === request.params.id)
      if (!certificate) throw new AppError('文书已被删除。', 404, 'DOCUMENT_NOT_FOUND')
      const result = await legacyOfficeBytes(certificate)
      if (result.file.id !== certificate.officeFile?.id) {
        certificate.officeFile = result.file
        await writeWorkspace(workspace)
      }
      return result
    })
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
    response.attachment(file.fileName)
    response.send(bytes)
  })
  return router
}
