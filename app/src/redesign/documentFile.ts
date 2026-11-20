import { api } from '../api'

export function supportsDocumentFile(name: string) {
  return /\.(docx?|txt)$/i.test(name)
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
