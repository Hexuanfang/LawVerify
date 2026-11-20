import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Document, Packer, Paragraph } from 'docx'

const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = mkdtempSync(path.join(os.tmpdir(), 'lawverify-stability-'))
const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Word worker verification')] }] }))
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LawVerify 稳定性回归</title>
<style>body{margin:20px;font-family:sans-serif}.pdf-preview{height:350px}</style></head>
<body><h1>稳定性回归</h1>
<div id="boundary"></div><div id="pdf"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PdfPreview} from '/src/PdfPreview.tsx';
import {StabilityBoundary} from '/src/StabilityBoundary.tsx';
import {draftKey,readDraft,writeDraft,removeDraft} from '/src/draft-store.ts';
import {importWordContent} from '/src/word-import.ts';
import {readBoundedSource,boundedFetch} from '/src/bounded-fetch.ts';
window.testFailures=[];
window.addEventListener('unhandledrejection',event=>window.testFailures.push(String(event.reason)));
const roots={};
for(const id of ['boundary','pdf']) roots[id]=createRoot(document.getElementById(id));
window.stabilityTests={draftKey,readDraft,writeDraft,removeDraft,importWordContent,readBoundedSource,boundedFetch,
mountPdf:()=>roots.pdf.render(React.createElement(PdfPreview,{sourceUrl:'/__fixture.pdf',name:'PDF 回归'})),
unmountPdf:()=>roots.pdf.render(null),
throwBoundary:()=>{const Broken=()=>{throw new Error('Synthetic boundary test')};
roots.boundary.render(React.createElement(StabilityBoundary,{module:true},React.createElement(Broken)))}};
window.testReady=true;
</script></body></html>`

function pdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 35 >>\nstream\nBT /F1 14 Tf 20 80 Td (One) Tj ET\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    '<< /Length 35 >>\nstream\nBT /F1 14 Tf 20 80 Td (Two) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let result = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result))
    result += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const offset = Buffer.byteLength(result)
  result += 'xref\n0 8\n0000000000 65535 f \n'
  for (const position of offsets.slice(1)) result += `${String(position).padStart(10, '0')} 00000 n \n`
  return Buffer.from(result + `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`)
}

const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(temporary, 'vite'),
  server: { host: '127.0.0.1', port: 8787, strictPort: true, hmr: false, watch: null },
  optimizeDeps: {
    noDiscovery: true,
    include: ['react', 'react-dom/client', 'pdfjs-dist'],
  },
  plugins: [{
    name: 'stability-fixtures',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
  if (request.url === '/__stability') {
    response.setHeader('Content-Type', 'text/html;charset=utf-8')
    response.end(await vite.transformIndexHtml('/__stability', html))
  } else if (request.url === '/__fixture.docx') response.end(docx)
  else if (request.url === '/api/documents/parse' && request.method === 'POST') {
    const parts = []
    for await (const part of request) parts.push(part)
    if (!Buffer.concat(parts).includes(docx)) {
      response.statusCode = 400
      return response.end(JSON.stringify({ message: 'Word 导入未提交原件' }))
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ text: 'Word worker verification', html: '<p>Word worker verification</p>', warnings: [] }))
  }
  else if (request.url === '/__fixture.pdf') {
    response.setHeader('Content-Type', 'application/pdf')
    response.end(pdf())
  } else next()
      })
    },
  }],
})
await server.listen()
console.log('Stability test page: http://127.0.0.1:8787/__stability')
if (!process.argv.includes('--serve-only')) {
  const require = createRequire(import.meta.url)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [path.join(root, 'electron/test-stability-runtime.cjs')], {
        env, stdio: 'inherit', windowsHide: true,
      })
      child.once('error', reject)
      child.once('exit', resolve)
    })
    process.exitCode = code ?? 1
  } finally {
    await server.close()
    rmSync(temporary, { recursive: true, force: true })
  }
} else {
  const stop = async () => { await server.close(); rmSync(temporary, { recursive: true, force: true }); process.exit() }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
