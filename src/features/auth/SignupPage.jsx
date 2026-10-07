import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import AuthLayout, { Field, FormError } from './AuthLayout.jsx'
import { messageForError } from './authErrors.js'

export default function SignupPage() {
  const { signUp } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    if (Array.from(password).length < 12) {
      setError('Use at least 12 characters.')
      return
    }
    setBusy(true)
    setError('')
    const result = await signUp(email, password)
    setBusy(false)
    if (result.ok) setSent(true)
    else setError(messageForError(result.error))
  }

  if (sent) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="If this address can be used, we sent a confirmation link. Open it in this browser to finish."
        footer={
          <Link to="/login" className="auth-link">
            Back to sign in
          </Link>
        }
      >
        <p className="text-body-sm text-secondary">
          Didn’t get it? Sign up again with the same email to receive a new link.
        </p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Create your account"
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="auth-link">
            Sign in
          </Link>
        </>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <Field id="signup-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <Field id="signup-password" label="Password" type="password" autoComplete="new-password" hint="At least 12 characters." value={password} onChange={(e) => setPassword(e.target.value)} required />
        <FormError message={error} />
        <button type="submit" className="auth-btn-primary motion-interactive" disabled={busy || !email || !password}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  )
}
