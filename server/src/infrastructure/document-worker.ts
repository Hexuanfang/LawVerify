import * as mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import { readFile } from 'node:fs/promises'
import { extractLegacyDocText, isLegacyDocFile } from './legacy-doc-text.js'

let buffer = Buffer.alloc(0)
let parser: PDFParse | undefined
const pdf = () => parser ??= new PDFParse({ data: buffer, maxImageSize: 16000000, isEvalSupported: false })
// 初始化可能要先从磁盘读整份原件：业务请求必须等初始化完成，否则会在空 buffer 上解析。
let ready: Promise<void> = Promise.resolve()

process.on('disconnect', () => process.exit(0))
process.on('message', async (message: unknown) => {
  const { type, bytes, path, id, action, page } = message as { type?: string; bytes?: Buffer; path?: string; id: number; action: string; page: number }
  if (type === 'initialize') {
    // 大原件按路径读取：主进程不再需要把整个文件塞进 IPC 消息。
    ready = (async () => {
      buffer = path ? await readFile(path) : Buffer.from(bytes!)
    })()
    await ready
    return
  }
  try {
    await ready
    let result: unknown
    if (action === 'word') {
      // .docx 是 zip+mammoth；旧版 .doc 是 OLE2 二进制，只能自己按 MS-DOC 解析。
      result = isLegacyDocFile(buffer)
        ? extractLegacyDocText(buffer)
        : (await mammoth.extractRawText({ buffer })).value
      if ((result as string).length > 8000000) throw new Error('Document text too large')
    } else if (action === 'info') {
      const info = await pdf().getInfo()
      if (info.total > 1000) throw new Error('PDF exceeds page limit')
      result = info.total
    } else if (action === 'text') {
      const text = await pdf().getText({ pageJoiner: '\n\n----- 第 page_number / total_number 页 -----\n\n' })
      if (text.text.length > 8000000) throw new Error('Document text too large')
      result = text.text
    } else if (action === 'page') {
      const screenshot = await pdf().getScreenshot({
        partial: [page], desiredWidth: 1400, imageDataUrl: true, imageBuffer: false,
      })
      result = screenshot.pages[0]?.dataUrl
      if (!result || (result as string).length > 16000000) throw new Error('PDF page too large')
    } else throw new Error('Unsupported action')
    process.send?.({ id, result })
  } catch {
    process.send?.({ id, failed: true })
  }
})
