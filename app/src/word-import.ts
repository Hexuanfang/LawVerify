import { api } from './api'

let importing = false

export async function importWordContent(file: File, signal?: AbortSignal) {
  if (importing) throw new Error('正在读取文稿，请稍候。')
  if (file.size > 20 * 1024 * 1024) throw new Error('文稿超过20MB，请拆分后导入。')
  importing = true
  try {
    return await api.parseDocument(file, signal)
  } finally {
    importing = false
  }
}
