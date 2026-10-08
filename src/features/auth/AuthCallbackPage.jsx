import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import AuthLayout from './AuthLayout.jsx'
import { messageForError } from './authErrors.js'

// Landing page for email links (PKCE). Reads the one-time code from the URL, removes it from the address
// bar immediately, and exchanges it through POST /api/auth/callback. Nothing here has side effects on GET.
export default function AuthCallbackPage({ purpose = null }) {
  const { completeCallback } = useAuth()
  const [error, setError] = useState('')
  const started = useRef(false)

  useEffect(() => {
    // Guard instead of a cleanup flag: StrictMode runs effects twice and the code is single-use.
    if (started.current) return
    started.current = true

    const search = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const code = search.get('code')
    const flowId = search.get('sb_flow_id')
    const providerError = search.get('error') || hash.get('error')
    window.history.replaceState({}, '', window.location.pathname)

    if (providerError || !code) {
      setError(messageForError({ code: 'link_invalid_or_expired' }))
      return
    }
    completeCallback({ code, flowId, purpose }).then((result) => {
      if (!result.ok) setError(messageForError(result.error))
    })
  }, [completeCallback, purpose])

  if (error) {
    return (
      <AuthLayout
        title="That link didn’t work"
        subtitle={error}
        footer={
          <>
            <Link to="/login" className="auth-link">
              Sign in
            </Link>{' '}
            ·{' '}
            <Link to="/forgot-password" className="auth-link">
              Reset password
            </Link>
          </>
        }
      />
    )
  }
  return <AuthLayout title="Confirming…" subtitle="One moment." />
}
