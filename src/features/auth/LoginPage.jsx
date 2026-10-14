import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Github } from 'lucide-react'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import AuthLayout, { Field, FormError } from './AuthLayout.jsx'
import { messageForError } from './authErrors.js'
import './oauth.css'

export default function LoginPage() {
  const { signIn, startOAuth } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy || oauthBusy) return
    setBusy(true)
    setError('')
    const result = await signIn(email, password, location.state && location.state.from)
    if (!result.ok) {
      setError(messageForError(result.error))
      setBusy(false)
    }
    // On success the provider wipes local demo data and hard-navigates.
  }

  async function handleGitHub() {
    if (busy || oauthBusy) return
    setOauthBusy(true)
    setError('')
    const result = await startOAuth('github')
    if (!result.ok) {
      setError(messageForError(result.error))
      setOauthBusy(false)
    }
    // On success the browser is already navigating to GitHub; keep the button disabled until it leaves.
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back to Ombre."
      footer={
        <>
          New to Ombre?{' '}
          <Link to="/signup" className="auth-link">
            Create an account
          </Link>
        </>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <Field id="login-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <Field id="login-password" label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <FormError message={error} />
        <button type="submit" className="auth-btn-primary motion-interactive" disabled={busy || oauthBusy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <Link to="/forgot-password" className="auth-link text-body-sm">
          Forgot your password?
        </Link>
      </form>

      <div className="auth-divider" role="separator">
        <span>or</span>
      </div>
      <button type="button" className="auth-btn-oauth motion-interactive" onClick={handleGitHub} disabled={busy || oauthBusy}>
        <Github size={18} strokeWidth={1.75} aria-hidden="true" />
        {oauthBusy ? 'Redirecting to GitHub…' : 'Continue with GitHub'}
      </button>
    </AuthLayout>
  )
}
