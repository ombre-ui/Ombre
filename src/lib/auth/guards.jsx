import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider.jsx'
import '../../features/auth/auth.css'

function Splash({ children }) {
  return (
    <div className="auth-splash" role="status" aria-live="polite">
      {children}
    </div>
  )
}

function Unavailable({ onRetry }) {
  return (
    <Splash>
      <p className="text-body">Ombre can’t be reached right now.</p>
      <button type="button" className="auth-btn-primary motion-interactive" onClick={onRetry}>
        Try again
      </button>
    </Splash>
  )
}

export function RequireAuth() {
  const { status, refresh } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <Splash>Loading…</Splash>
  if (status === 'error') return <Unavailable onRetry={refresh} />
  if (status !== 'authenticated') {
    const from = `${location.pathname}${location.search}${location.hash}`
    return <Navigate to="/login" replace state={{ from }} />
  }
  return <Outlet />
}

export function PublicOnly() {
  const { status, refresh } = useAuth()
  if (status === 'loading') return <Splash>Loading…</Splash>
  if (status === 'error') return <Unavailable onRetry={refresh} />
  if (status === 'authenticated') return <Navigate to="/app/general" replace />
  return <Outlet />
}
