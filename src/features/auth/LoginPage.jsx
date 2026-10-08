import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import AuthLayout, { Field, FormError } from './AuthLayout.jsx'
import { messageForError } from './authErrors.js'

export default function LoginPage() {
  const { signIn } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const result = await signIn(email, password, location.state && location.state.from)
    if (!result.ok) {
      setError(messageForError(result.error))
      setBusy(false)
    }
    // On success the provider wipes local demo data and hard-navigates.
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
        <button type="submit" className="auth-btn-primary motion-interactive" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <Link to="/forgot-password" className="auth-link text-body-sm">
          Forgot your password?
        </Link>
      </form>
    </AuthLayout>
  )
}
