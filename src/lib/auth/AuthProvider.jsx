import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { apiRequest } from './api.js'
import { wipeAndNavigate } from './localData.js'
import { safeInternalPath, safeServerNext } from './paths.js'

const AuthContext = createContext(null)

const REVALIDATE_MS = 10 * 60 * 1000 // keeps the server-side session fresh (rotation happens server-side)
const MIN_GAP_MS = 60 * 1000

export function AuthProvider({ children }) {
  // status: 'loading' | 'authenticated' | 'unauthenticated' | 'error'
  const [state, setState] = useState({ status: 'loading', user: null })
  const inflight = useRef(null)
  const lastRun = useRef(0)

  // Single-flight session check: one request at a time, so parallel callers never race a refresh.
  const refresh = useCallback(() => {
    if (inflight.current) return inflight.current
    lastRun.current = Date.now()
    const run = (async () => {
      const result = await apiRequest('/api/auth/session')
      if (result.ok) {
        const user = result.data && result.data.user
        setState(user ? { status: 'authenticated', user } : { status: 'unauthenticated', user: null })
      } else if (result.status === 0 || result.status >= 500) {
        // Transient failure: never sign the user out because of an outage.
        setState((prev) => (prev.status === 'loading' ? { status: 'error', user: null } : prev))
      } else {
        setState({ status: 'unauthenticated', user: null })
      }
    })().finally(() => {
      inflight.current = null
    })
    inflight.current = run
    return run
  }, [])

  useEffect(() => {
    refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRun.current > MIN_GAP_MS) refresh()
    }
    const timer = window.setInterval(onVisible, REVALIDATE_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  const signIn = useCallback(async (email, password, target) => {
    const result = await apiRequest('/api/auth/signin', { method: 'POST', body: { email, password } })
    if (result.ok) wipeAndNavigate(safeInternalPath(target)) // wipe local demo data, then hard navigation
    return result
  }, [])

  const signUp = useCallback((email, password) => apiRequest('/api/auth/signup', { method: 'POST', body: { email, password } }), [])

  const forgotPassword = useCallback((email) => apiRequest('/api/auth/forgot-password', { method: 'POST', body: { email } }), [])

  const completeCallback = useCallback(async ({ code, flowId, purpose }) => {
    const body = { code }
    if (flowId) body.flowId = flowId
    if (purpose) body.purpose = purpose
    const result = await apiRequest('/api/auth/callback', { method: 'POST', body })
    if (result.ok) wipeAndNavigate(safeServerNext(result.data && result.data.next))
    return result
  }, [])

  const resetPassword = useCallback((password) => apiRequest('/api/auth/reset-password', { method: 'POST', body: { password } }), [])

  const signOut = useCallback(async () => {
    const result = await apiRequest('/api/auth/signout', { method: 'POST' })
    if (result.ok) wipeAndNavigate('/login')
    return result
  }, [])

  const value = useMemo(
    () => ({ ...state, refresh, signIn, signUp, forgotPassword, completeCallback, resetPassword, signOut }),
    [state, refresh, signIn, signUp, forgotPassword, completeCallback, resetPassword, signOut]
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
