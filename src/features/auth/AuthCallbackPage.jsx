import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import { classifyReturn } from '../../lib/auth/oauth.js'
import AuthLayout from './AuthLayout.jsx'
import { messageForError } from './authErrors.js'

// Landing page for email links and OAuth returns (PKCE). Reads the one-time code from the URL, removes it from
// the address bar immediately, and exchanges it through POST /api/auth/callback. Nothing here has side effects
// on GET. purpose: null (email confirmation), 'recovery' (password reset) or 'oauth' (GitHub sign-in).
const OAUTH_ERROR_CODE = { cancelled: 'oauth_cancelled', expired: 'oauth_expired', failed: 'oauth_incomplete' }

export default function AuthCallbackPage({ purpose = null }) {
  const { completeCallback } = useAuth()
  const [error, setError] = useState('')
  const started = useRef(false)
  const isOAuth = purpose === 'oauth'

  useEffect(() => {
    // Guard instead of a cleanup flag: StrictMode runs effects twice and the code is single-use.
    if (started.current) return
    started.current = true

    const search = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const outcome = classifyReturn(search, hash)
    window.history.replaceState({}, '', window.location.pathname) // the code never stays in the address bar

    if (outcome.kind !== 'code') {
      setError(messageForError({ code: isOAuth ? OAUTH_ERROR_CODE[outcome.kind] : 'link_invalid_or_expired' }))
      return
    }
    completeCallback({ code: outcome.code, flowId: outcome.flowId, purpose }).then((result) => {
      if (result.ok) return
      const code = result.error && result.error.code
      // For OAuth, "wrong browser" and "expired link" both mean: start the sign-in again from here.
      const mapped = isOAuth && (code === 'link_wrong_browser' || code === 'link_invalid_or_expired') ? { code: 'oauth_expired' } : result.error
      setError(messageForError(mapped))
    })
  }, [completeCallback, purpose, isOAuth])

  if (error) {
    return (
      <AuthLayout
        title={isOAuth ? 'Sign-in didn’t complete' : 'That link didn’t work'}
        subtitle={error}
        footer={
          isOAuth ? (
            <Link to="/login" className="auth-link">
              Back to sign in
            </Link>
          ) : (
            <>
              <Link to="/login" className="auth-link">
                Sign in
              </Link>{' '}
              ·{' '}
              <Link to="/forgot-password" className="auth-link">
                Reset password
              </Link>
            </>
          )
        }
      />
    )
  }
  return <AuthLayout title={isOAuth ? 'Signing you in…' : 'Confirming…'} subtitle="One moment." />
}
