import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export function PdfPreview({ sourceUrl, name }: { sourceUrl: string; name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [width, setWidth] = useState(500)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setPdf(null)
    setPage(1)
    setError('')
    setLoading(true)
    const task = getDocument({
      url: sourceUrl, disableAutoFetch: true, disableStream: true,
      rangeChunkSize: 256 * 1024,
      cMapUrl: `${import.meta.env.BASE_URL}pdf-assets/cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${import.meta.env.BASE_URL}pdf-assets/standard_fonts/`,
      wasmUrl: `${import.meta.env.BASE_URL}pdf-assets/wasm/`,
    })
    const timer = setTimeout(() => {
      if (active) { setError('原件读取超时，请重试。'); setLoading(false) }
      void task.destroy()
    }, 30000)
    void task.promise.then(document => {
      clearTimeout(timer)
      if (active) setPdf(document)
    }).catch(() => {
      clearTimeout(timer)
      if (active) { setError('PDF 暂时无法预览，请打开原件查看。'); setLoading(false) }
    })
    return () => { active = false; clearTimeout(timer); void task.destroy() }
  }, [sourceUrl])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(entries => {
      setWidth(Math.max(200, Math.round(entries[0].contentRect.width)))
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!pdf || !canvas) return
    let active = true
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined
    setLoading(true)
    setError('')
    void pdf.getPage(page).then(async currentPage => {
      if (!active) return
      const base = currentPage.getViewport({ scale: 1 })
      const desiredScale = (width - 16) / base.width * Math.min(window.devicePixelRatio, 2)
      const scale = Math.min(desiredScale, Math.sqrt(4000000 / (base.width * base.height)))
      const viewport = currentPage.getViewport({ scale })
      const staging = document.createElement('canvas')
      staging.width = Math.ceil(viewport.width)
      staging.height = Math.ceil(viewport.height)
      renderTask = currentPage.render({ canvas: staging, viewport })
      try {
        await renderTask.promise
        if (active) {
          canvas.width = staging.width
          canvas.height = staging.height
          canvas.style.width = `${width - 16}px`
          canvas.style.height = 'auto'
          canvas.getContext('2d')?.drawImage(staging, 0, 0)
        }
      } finally {
        staging.width = 0
        staging.height = 0
        currentPage.cleanup()
      }
      if (active) setLoading(false)
    }).catch(error => {
      if (active && error?.name !== 'RenderingCancelledException') {
        setError('当前页暂时无法预览，请打开原件查看。')
        setLoading(false)
      }
    })
    return () => {
      active = false
      renderTask?.cancel()
    }
  }, [pdf, page, width])

  useEffect(() => () => {
    const canvas = canvasRef.current
    if (canvas) { canvas.width = 0; canvas.height = 0 }
  }, [])

  return <div className="pdf-preview" ref={hostRef}>
    <div className="pdf-preview-toolbar">
      <button type="button" disabled={!pdf || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button>
      <span>{page} / {pdf?.numPages ?? '-'}</span>
      <button type="button" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(value => value + 1)}>下一页</button>
    </div>
    {loading && !error ? <p role="status">正在读取原件...</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <canvas ref={canvasRef} aria-label={`${name} 第 ${page} 页`} hidden={Boolean(error)} />
  </div>
}
