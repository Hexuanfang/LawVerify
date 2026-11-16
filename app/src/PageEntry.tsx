import { AUTH_CHANGED } from './auth-transition'
import { loadRedesign } from './redesign-loader'
import { StartupScreen } from './StartupScreen'
import { lazy, startTransition, Suspense, useEffect, useState } from 'react'

const Legacy = lazy(() => import('./LegacyEntry'))
const Redesign = lazy(loadRedesign)

export default function PageEntry() {
  const [authenticated, setAuthenticated] = useState(
    Boolean(sessionStorage.getItem('lawverify-auth-session')),
  )
  const legacy = new URLSearchParams(location.search).get('ui') === 'legacy'
  useEffect(() => {
    const sync = () => {
      if (sessionStorage.getItem('lawverify-auth-session')) startTransition(() => setAuthenticated(true))
      else setAuthenticated(false)
    }
    window.addEventListener(AUTH_CHANGED, sync)
    window.addEventListener('storage', sync)
    window.addEventListener('focus', sync)
    return () => {
      window.removeEventListener(AUTH_CHANGED, sync)
      window.removeEventListener('storage', sync)
      window.removeEventListener('focus', sync)
    }
  }, [])

  return (
    <Suspense
      fallback={<StartupScreen />}
    >
      {legacy || !authenticated ? <Legacy /> : <Redesign />}
      {legacy && authenticated && (
        <button
          type="button"
          onClick={() => {
            const url = new URL(location.href)
            url.searchParams.set('ui', 'new')
            location.assign(url.href)
          }}
          style={{
            position: 'fixed',
            bottom: 12,
            left: 80,
            zIndex: 10000,
            padding: '6px 12px',
            background: '#16181d',
            color: '#fff',
            borderRadius: 8,
          }}
        >
          进入新版
        </button>
      )}
    </Suspense>
  )
}
