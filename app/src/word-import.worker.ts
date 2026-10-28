import * as mammoth from 'mammoth/mammoth.browser'

self.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
  try {
    const text = await mammoth.extractRawText({ arrayBuffer: data })
    const html = await mammoth.convertToHtml({ arrayBuffer: data })
    if (text.value.length + html.value.length > 8000000) throw new Error('Document too large')
    self.postMessage({ text: text.value, html: html.value })
  } catch {
    self.postMessage({ failed: true })
  }
}
