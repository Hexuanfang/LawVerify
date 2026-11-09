/**
 * 证据原件的 MIME 推断。
 *
 * 目录同步、Electron 文件读取等链路拿不到浏览器给出的 file.type，
 * 若不补全类型，服务端只能回退到 application/octet-stream，
 * 会导致图片证据无法被识别为可视觉理解的原件。
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf',
  wps: 'application/vnd.ms-works',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
}

const GENERIC_MIME_TYPES = new Set(['application/octet-stream', 'binary/octet-stream'])

export function isGenericMimeType(mimeType?: string) {
  const normalized = mimeType?.trim().toLowerCase() ?? ''
  return !normalized || GENERIC_MIME_TYPES.has(normalized)
}

export function inferMimeTypeFromFileName(fileName: string) {
  const extension = fileName.split('.').pop()?.trim().toLowerCase() ?? ''
  return MIME_BY_EXTENSION[extension] ?? ''
}

/** 优先沿用调用方给出的 MIME，缺失或为通用二进制类型时按文件名推断。 */
export function resolveEvidenceMimeType(fileName: string, mimeType?: string) {
  if (!isGenericMimeType(mimeType)) {
    return mimeType!.trim()
  }

  return inferMimeTypeFromFileName(fileName)
}
