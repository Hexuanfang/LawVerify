import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Read the desktop version once so the login page can render it.
const appPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version?: string }
const appVersion = appPackage.version ?? '0.0.0'

// https://vite.dev/config/
// env: .env.local → VITE_ACCOUNT_CENTER_URL / VITE_CLOUD_API_BASE_URL
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
