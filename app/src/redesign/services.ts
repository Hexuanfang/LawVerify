import { api } from '../api'
import { importWordContent } from '../word-import'
import { DEFAULT_EXPORT_OPTIONS } from '../export-context'
import type { AppState, DocKey } from '../types'
import { supportsDocumentFile, downloadDocumentFile } from './documentFile'
import { requireWordExportSnapshot } from './workflow'

export function readDocument(file: File, signal?: AbortSignal) {
  return importWordContent(file, signal)
}
export async function importDocument(caseId: string, file: File, signal?: AbortSignal, onProgress?: (message: string) => void, docKey?: DocKey) {
  if (!supportsDocumentFile(file.name)) throw new Error('文书仅支持 Word（.doc、.docx）或 TXT。')
  if (file.size > 20 * 1024 * 1024) throw new Error('文书超过 20 MB，请拆分后导入。')
  onProgress?.('正在解析文书')
  return api.importDocumentFile(caseId, file, signal, docKey)
}

export async function exportDocument(
  workspace: AppState,
  certificateId: string,
  mode: 'review' | 'clean' | 'original',
) {
  if (mode === 'original') {
    await requireWordExportSnapshot(workspace, certificateId)
    return downloadDocumentFile(certificateId)
  }
  const review = mode === 'review'
  const { exportCertificateToWord } = await import('../export-word')
  return exportCertificateToWord(workspace, certificateId, {
    appVersion: __APP_VERSION__,
    options: {
      ...DEFAULT_EXPORT_OPTIONS,
      evidenceCatalog: review,
      verificationRecord: true,
      useWordComments: review,
      bodyAnnotations: review,
    },
  })
}
