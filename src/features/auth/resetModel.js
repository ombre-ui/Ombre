// Pure model for the password-reset code screens (ForgotPasswordPage.jsx). No React, no storage.

export const RESET_CODE_LENGTH = 7
export const RESEND_COOLDOWN_SECONDS = 60

// Shown after every request, whether or not an account exists (the server answers identically).
export const NEUTRAL_REQUEST_MESSAGE = 'If an account exists for this email, we’ll send a reset code.'

// Keeps digits only (pasted "123 4567" works) and never more than the code length.
export function normalizeCode(input) {
  return String(input ?? '').replace(/\D/g, '').slice(0, RESET_CODE_LENGTH)
}

export function isCompleteCode(input) {
  return normalizeCode(input).length === RESET_CODE_LENGTH
}

export function tick(seconds) {
  return Math.max(0, seconds - 1)
}

export function resendLabel(seconds) {
  return seconds > 0 ? `Send a new code in ${seconds}s` : 'Send a new code'
}
