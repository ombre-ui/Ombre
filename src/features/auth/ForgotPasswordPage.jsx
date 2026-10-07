import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import AuthLayout, { Field, FormError } from './AuthLayout.jsx'
import { messageForError } from './authErrors.js'

export default function ForgotPasswordPage() {
  const { forgotPassword } = useAuth()
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const result = await forgotPassword(email)
    setBusy(false)
    if (result.ok) setSent(true)
    else setError(messageForError(result.error))
  }

  const back = (
    <Link to="/login" className="auth-link">
      Back to sign in
    </Link>
  )

  if (sent) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="If an account exists for that address, we sent a reset link. Open it in this browser."
        footer={back}
      />
    )
  }

  return (
    <AuthLayout title="Reset your password" subtitle="Enter your email and we’ll send a reset link." footer={back}>
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <Field id="forgot-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <FormError message={error} />
        <button type="submit" className="auth-btn-primary motion-interactive" disabled={busy || !email}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
    </AuthLayout>
  )
}
