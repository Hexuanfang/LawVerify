import { api } from '../api'
import { importWordContent } from '../word-import'
import { DEFAULT_EXPORT_OPTIONS } from '../export-context'
import type { AppState, Certificate } from '../types'
import { paragraphElements, STATUS_NAMES } from './model'

export function readDocument(file: File) {
  return importWordContent(file)
}
export async function importDocument(caseId: string, file: File) {
  const content = await readDocument(file)
  if (!content.text.trim()) throw new Error(`${file.name} 未读取到正文。`)
  return api.importCertificate({
    caseId,
    title: file.name.replace(/\.[^.]+$/, ''),
    sourceFileName: file.name,
    content: content.text,
    paragraphs: content.html
      ? Array.from(
          new DOMParser().parseFromString(content.html, 'text/html').body
            .children,
        )
          .filter((element) => element.textContent?.trim())
          .map((element) => ({
            text: element.textContent!.trim(),
            richText: element.outerHTML,
          }))
      : undefined,
  })
}

export async function exportDocument(
  workspace: AppState,
  certificate: Certificate,
  review: boolean,
) {
  const annotated = {
    ...certificate,
    paragraphs: certificate.paragraphs.map((paragraph) => {
      const elements = paragraphElements(paragraph, workspace, certificate.id)
      const summary = elements
        .map(
          (element) =>
            `${STATUS_NAMES[element.verdict]}：${element.quote}（${element.reason}）`,
        )
        .join('\n')
      return {
        ...paragraph,
        note: [paragraph.note, summary].filter(Boolean).join('\n'),
      }
    }),
  }
  const { exportCertificateToWord } = await import('../export-word')
  return exportCertificateToWord({
    certificate: annotated,
    caseFolder:
      workspace.cases.find((item) => item.id === certificate.caseId) ?? null,
    evidences: workspace.evidences.filter(
      (evidence) => evidence.caseId === certificate.caseId,
    ),
    roleLabel: certificate.role === 'defendant' ? '被告' : '原告',
    appVersion: __APP_VERSION__,
    operator: workspace.user.name || workspace.user.email,
    exportedAt: new Date(),
    options: {
      ...DEFAULT_EXPORT_OPTIONS,
      evidenceCatalog: review,
      verificationRecord: true,
      useWordComments: review,
      bodyAnnotations: review,
    },
  })
}
