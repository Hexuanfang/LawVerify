import * as mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

let buffer = Buffer.alloc(0)
let parser: PDFParse | undefined
const pdf = () => parser ??= new PDFParse({ data: buffer, maxImageSize: 16000000, isEvalSupported: false })

process.on('disconnect', () => process.exit(0))
process.on('message', async (message: unknown) => {
  const { type, bytes, id, action, page } = message as { type?: string; bytes?: Buffer; id: number; action: string; page: number }
  if (type === 'initialize') { buffer = Buffer.from(bytes!); return }
  try {
    let result: unknown
    if (action === 'word') {
      result = (await mammoth.extractRawText({ buffer })).value
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
