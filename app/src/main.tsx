import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ServiceRecoveryNotice, StabilityBoundary } from './StabilityBoundary'
import { installStabilityMonitoring } from './stability-monitor'
import { applyTheme, getInitialTheme } from './theme'

installStabilityMonitoring()

// 首帧前同步主题，避免深色主题切换时出现浅色闪烁。
applyTheme(getInitialTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StabilityBoundary>
      <App />
    </StabilityBoundary>
    <ServiceRecoveryNotice />
  </StrictMode>,
)
