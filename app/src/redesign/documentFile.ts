import { api } from '../api'

export { documentFileAccept, supportsDocumentFile } from './caseFileKind'
export const documentFileHint = '文书支持 Word（.doc、.docx）、TXT 或 Markdown（.md、.markdown）。'

export type DocxWork = { bytes: Blob; expectedFileVersion: string }

export async function readDocxWork(id: string, signal: AbortSignal): Promise<DocxWork | undefined> {
  const response = await api.documentEditSource(id, signal)
  if (response.status === 409) return undefined
  const expectedFileVersion = response.headers.get('X-LawVerify-Office-Version')
  if (!response.ok || !expectedFileVersion) throw new Error('无法读取 Word 工作副本，请重新打开文书。')
  return { bytes: await response.blob(), expectedFileVersion }
}

export async function downloadDocumentFile(id: string) {
  const response = await api.documentFileResponse(id)
  if (!response.ok) throw new Error('文书下载失败，请检查服务连接后重试。')
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  const quoted = /filename="((?:\\.|[^"])*)"/i.exec(disposition)?.[1]
  const name = encoded ? decodeURIComponent(encoded) : quoted?.replace(/\\(.)/g, '$1') ?? '文书.docx'
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
