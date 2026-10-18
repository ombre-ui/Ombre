import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import AuthLayout, { Field, FormError } from './AuthLayout.jsx'
import { messageForError } from './authErrors.js'
import { NEUTRAL_REQUEST_MESSAGE, RESEND_COOLDOWN_SECONDS, RESET_CODE_LENGTH, isCompleteCode, normalizeCode, resendLabel, tick } from './resetModel.js'

// Step 1: ask for the email. Step 2: enter the 7-digit code from the email. On success the server has set the
// normal HttpOnly session cookie and the provider hard-navigates to /reset-password (new password + confirm).
// The code lives only in this component's state while it is typed: never in the URL, storage or a cookie.
export default function ForgotPasswordPage() {
  const { requestResetCode, verifyResetCode } = useAuth()
  const [step, setStep] = useState('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = window.setTimeout(() => setCooldown((s) => tick(s)), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  async function sendCode(e) {
    if (e) e.preventDefault()
    if (busy || (step === 'code' && cooldown > 0)) return
    setBusy(true)
    setError('')
    const result = await requestResetCode(email)
    setBusy(false)
    if (!result.ok) {
      setError(messageForError(result.error))
      return
    }
    setCode('')
    setStep('code')
    setCooldown(RESEND_COOLDOWN_SECONDS) // neutral, client-side: identical for every address
  }

  async function submitCode(e) {
    e.preventDefault()
    if (busy || !isCompleteCode(code)) return
    setBusy(true)
    setError('')
    const result = await verifyResetCode(email, code)
    if (!result.ok) {
      setError(messageForError(result.error))
      setBusy(false)
    }
    // On success the provider hard-navigates to /reset-password.
  }

  if (step === 'code') {
    return (
      <AuthLayout
        title="Enter your code"
        subtitle={NEUTRAL_REQUEST_MESSAGE}
        footer={
          <Link to="/login" className="auth-link">
            Back to sign in
          </Link>
        }
      >
        <form className="auth-form" onSubmit={submitCode} noValidate>
          <Field
            id="reset-code"
            label={`${RESET_CODE_LENGTH}-digit code`}
            hint="It expires 60 minutes after it was sent. Each new code replaces the last one."
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={RESET_CODE_LENGTH}
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            required
            autoFocus
          />
          <FormError message={error} />
          <button type="submit" className="auth-btn-primary motion-interactive" disabled={busy || !isCompleteCode(code)}>
            {busy ? 'Checking…' : 'Verify code'}
          </button>
          <button type="button" className="auth-link text-body-sm auth-link-button" onClick={sendCode} disabled={busy || cooldown > 0}>
            {resendLabel(cooldown)}
          </button>
          <button
            type="button"
            className="auth-link text-body-sm auth-link-button"
            onClick={() => {
              setStep('email')
              setCode('')
              setError('')
            }}
          >
            Use a different email
          </button>
        </form>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle={`Enter your email. ${NEUTRAL_REQUEST_MESSAGE}`}
      footer={
        <Link to="/login" className="auth-link">
          Back to sign in
        </Link>
      }
    >
      <form className="auth-form" onSubmit={sendCode} noValidate>
        <Field id="forgot-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <FormError message={error} />
        <button type="submit" className="auth-btn-primary motion-interactive" disabled={busy || !email}>
          {busy ? 'Sending…' : 'Send reset code'}
        </button>
      </form>
    </AuthLayout>
  )
}
