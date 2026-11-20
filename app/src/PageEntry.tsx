import { AUTH_CHANGED } from './auth-transition'
import { loadRedesign } from './redesign-loader'
import { StartupScreen } from './StartupScreen'
import { lazy, startTransition, Suspense, useEffect, useState } from 'react'

const Auth = lazy(() => import('./features/auth/AuthPage'))
const Redesign = lazy(loadRedesign)

export default function PageEntry() {
  const [authenticated, setAuthenticated] = useState(
    Boolean(sessionStorage.getItem('lawverify-auth-session')),
  )
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
      {authenticated ? <Redesign /> : <Auth />}
    </Suspense>
  )
}
