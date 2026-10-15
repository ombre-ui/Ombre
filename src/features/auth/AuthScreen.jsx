import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Mail } from 'lucide-react'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import AuthLayout, { Field, FormError } from './AuthLayout.jsx'
import { ProviderMark } from './ProviderIcons.jsx'
import { messageForError } from './authErrors.js'
import { EMAIL_BUTTON_LABEL, OAUTH_BUTTONS, canSubmit, modeCopy, redirectingLabel, validateSignup } from './authScreenModel.js'
import './oauth.css'

// One screen for /login (mode="signin") and /signup (mode="signup"). Same secure backend flows as before:
// OAuth goes through POST /api/auth/oauth (server-side Supabase PKCE), email/password through the existing
// signin/signup routes. Google/GitHub users never see a password field.
export default function AuthScreen({ mode = 'signin' }) {
  const isSignup = mode === 'signup'
  const copy = modeCopy(mode)
  const { signIn, signUp, startOAuth } = useAuth()
  const location = useLocation()

  const [showEmail, setShowEmail] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [formError, setFormError] = useState('')
  const [oauthError, setOauthError] = useState('')
  const [busy, setBusy] = useState(false)
  const [oauthProvider, setOauthProvider] = useState(null)
  const [sent, setSent] = useState(false)

  const anyBusy = busy || oauthProvider !== null

  function revealEmail() {
    setShowEmail(true)
    // Already open: move focus to the first field. Newly opened: the field autofocuses on mount.
    document.getElementById('auth-email')?.focus()
  }

  async function handleOAuth(provider) {
    if (anyBusy) return
    setOauthProvider(provider)
    setOauthError('')
    setFormError('')
    const result = await startOAuth(provider)
    if (!result.ok) {
      setOauthError(messageForError(result.error))
      setOauthProvider(null)
    }
    // On success the browser is already navigating to the provider; keep the buttons disabled until it leaves.
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (anyBusy) return
    setOauthError('')
    if (isSignup) {
      const problem = validateSignup({ password, confirm })
      if (problem) {
        setFormError(messageForError({ code: problem }))
        return
      }
    }
    setBusy(true)
    setFormError('')
    if (isSignup) {
      const result = await signUp(email, password)
      setBusy(false)
      if (result.ok) setSent(true)
      else setFormError(messageForError(result.error))
      return
    }
    const result = await signIn(email, password, location.state && location.state.from)
    if (!result.ok) {
      setFormError(messageForError(result.error))
      setBusy(false)
    }
    // On success the provider wipes local demo data and hard-navigates.
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
        <p className="text-body-sm text-secondary">Didn’t get it? Sign up again with the same email to receive a new link.</p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title={copy.title}
      subtitle={
        <>
          {copy.lead}{' '}
          <Link to={copy.link.to} className="auth-link">
            {copy.link.text}
          </Link>
        </>
      }
    >
      <div className="auth-oauth-stack">
        {OAUTH_BUTTONS.map(({ provider, label, variant }) => (
          <button
            key={provider}
            type="button"
            className={`auth-btn-oauth auth-btn-oauth--${variant} motion-interactive`}
            data-provider={provider}
            onClick={() => handleOAuth(provider)}
            disabled={anyBusy}
          >
            <ProviderMark provider={provider} />
            {oauthProvider === provider ? redirectingLabel(provider) : label}
          </button>
        ))}
        <button
          type="button"
          className="auth-btn-oauth auth-btn-oauth--email motion-interactive"
          aria-expanded={showEmail}
          aria-controls="auth-email-section"
          onClick={revealEmail}
          disabled={anyBusy}
        >
          <Mail size={18} strokeWidth={1.75} aria-hidden="true" />
          {EMAIL_BUTTON_LABEL}
        </button>
      </div>
      <FormError message={oauthError} />

      {showEmail && (
        <section id="auth-email-section" className="auth-email-section">
          <div className="auth-divider" role="separator">
            <span>or</span>
          </div>
          <p className="text-body auth-email-heading">{copy.emailHeading}</p>
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <Field id="auth-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <Field
              id="auth-password"
              label="Password"
              type="password"
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              hint={isSignup ? 'At least 12 characters.' : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {isSignup && (
              <Field id="auth-confirm" label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            )}
            <FormError message={formError} />
            <button type="submit" className="auth-btn-primary motion-interactive" disabled={!canSubmit(mode, { email, password, confirm }, anyBusy)}>
              {busy ? copy.busy : copy.submit}
            </button>
            {!isSignup && (
              <Link to="/forgot-password" className="auth-link text-body-sm">
                Forgot your password?
              </Link>
            )}
          </form>
        </section>
      )}
    </AuthLayout>
  )
}
