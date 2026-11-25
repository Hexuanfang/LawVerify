import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Read the desktop version once so the login page can render it.
const appPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version?: string }
const appVersion = appPackage.version ?? '0.0.0'
const { loadReleaseEndpoints } = createRequire(import.meta.url)('./electron/release-endpoints.cjs') as {
  loadReleaseEndpoints: () => { loginBaseUrl: string }
}

// https://vite.dev/config/
// env: .env.local → VITE_ACCOUNT_CENTER_URL / VITE_CLOUD_API_BASE_URL
export default defineConfig(({ command }) => ({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [tailwindcss(), react(), {
    name: 'superdoc-license',
    apply: 'build',
    closeBundle() {
      const root = fileURLToPath(new URL('.', import.meta.url))
      const licenses = path.join(root, 'dist/licenses/superdoc')
      mkdirSync(licenses, { recursive: true })
      cpSync(path.join(root, 'node_modules/superdoc/LICENSE'), path.join(licenses, 'LICENSE'))
      for (const file of ['DOCX-ENGINE-LICENSE.md', 'NOTICE.md', 'THIRD_PARTY_NOTICES']) {
        cpSync(path.join(root, 'node_modules/@superdoc/docx-engine/dist', file), path.join(licenses, file))
      }
    },
  }, {
    name: 'pdf-preview-assets',
    closeBundle() {
      const root = fileURLToPath(new URL('.', import.meta.url))
      for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
        cpSync(path.join(root, 'node_modules/pdfjs-dist', folder), path.join(root, 'dist/pdf-assets', folder), { recursive: true })
      }
    },
    configureServer(server) {
      server.middlewares.use('/pdf-assets', (request, response, next) => {
        const match = /^\/(cmaps|standard_fonts|wasm)\/([a-z0-9_.-]+)$/i.exec((request.url ?? '').split('?')[0])
        if (!match) { next(); return }
        try {
          const file = fileURLToPath(new URL(`./node_modules/pdfjs-dist/${match[1]}/${match[2]}`, import.meta.url))
          if (match[2].endsWith('.wasm')) response.setHeader('Content-Type', 'application/wasm')
          response.end(readFileSync(file))
        } catch { response.statusCode = 404; response.end() }
      })
    },
  }],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __RELEASE_LOGIN_BASE_URL__: JSON.stringify(command === 'build' ? loadReleaseEndpoints().loginBaseUrl : ''),
  },
  server: {
    // Allow LAN browsers to access the hot-reload development server.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
}))

