import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import AuthLayout, { Field, FormError } from './AuthLayout.jsx'
import { messageForError } from './authErrors.js'

export default function ResetPasswordPage() {
  const { resetPassword } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    if (Array.from(password).length < 12) return setError('Use at least 12 characters.')
    if (password !== confirm) return setError('The passwords don’t match.')
    setBusy(true)
    setError('')
    const result = await resetPassword(password)
    setBusy(false)
    if (result.ok) navigate('/app/general', { replace: true })
    else setError(messageForError(result.error))
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="Use at least 12 characters.">
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <Field id="reset-password" label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        <Field id="reset-confirm" label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        <FormError message={error} />
        <button type="submit" className="auth-btn-primary motion-interactive" disabled={busy || !password || !confirm}>
          {busy ? 'Saving…' : 'Update password'}
        </button>
      </form>
    </AuthLayout>
  )
}
