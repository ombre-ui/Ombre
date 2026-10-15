// Pure model for the unified sign-in / create-account screen (AuthScreen.jsx). Kept free of React so the
// copy, ordering and validation rules can be tested without a browser.

// Order is the visual order. Google is the primary OAuth option, GitHub secondary; email is the fallback
// (rendered separately, after these).
export const OAUTH_BUTTONS = Object.freeze([
  Object.freeze({ provider: 'google', label: 'Continue with Google', variant: 'primary' }),
  Object.freeze({ provider: 'github', label: 'Continue with GitHub', variant: 'secondary' }),
])

export const EMAIL_BUTTON_LABEL = 'Continue with email'

const PROVIDER_NAME = Object.freeze({ google: 'Google', github: 'GitHub' })

export function redirectingLabel(provider) {
  return `Redirecting to ${PROVIDER_NAME[provider] || 'your provider'}…`
}

const COPY = Object.freeze({
  signin: Object.freeze({
    title: 'Sign in',
    lead: 'Don’t have an account?',
    link: Object.freeze({ to: '/signup', text: 'Create one' }),
    emailHeading: 'Already have an account?',
    submit: 'Sign in',
    busy: 'Signing in…',
  }),
  signup: Object.freeze({
    title: 'Create your account',
    lead: 'Already have an account?',
    link: Object.freeze({ to: '/login', text: 'Sign in' }),
    emailHeading: 'Create an account with email',
    submit: 'Create account',
    busy: 'Creating account…',
  }),
})

export function modeCopy(mode) {
  return COPY[mode] || COPY.signin
}

export const PASSWORD_MIN_LENGTH = 12

// Returns '' when fine, otherwise an error code understood by authErrors.messageForError.
// Sign-up only: the server enforces the same minimum, this just answers before a round trip.
export function validateSignup({ password, confirm }) {
  if (Array.from(password).length < PASSWORD_MIN_LENGTH) return 'weak_password'
  if (password !== confirm) return 'password_mismatch'
  return ''
}

export function canSubmit(mode, { email, password, confirm }, busy) {
  if (busy) return false
  if (!email || !password) return false
  if (mode === 'signup' && !confirm) return false
  return true
}
