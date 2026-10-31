import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ServiceRecoveryNotice, StabilityBoundary } from './StabilityBoundary'
import { installStabilityMonitoring } from './stability-monitor'

installStabilityMonitoring()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StabilityBoundary>
      <App />
    </StabilityBoundary>
    <ServiceRecoveryNotice />
  </StrictMode>,
)
