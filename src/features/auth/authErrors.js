const MESSAGES = {
  invalid_credentials: 'Email or password is incorrect.',
  email_not_confirmed:
    'Confirm your email first using the link we sent. If it expired, sign up again with the same email to get a new link.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  weak_password: 'Use at least 12 characters.',
  same_password: 'Choose a password you haven’t used before.',
  recent_login_required: 'For security, sign in again, then retry.',
  invalid_request: 'Check the details you entered and try again.',
  signup_failed: 'We couldn’t create the account. Check your details and try again.',
  reset_failed: 'We couldn’t update the password. Try again.',
  link_invalid_or_expired: 'This link is invalid or has expired. Request a new one.',
  link_wrong_browser: 'Open the link in the same browser where you started. Or request a new link.',
  unauthenticated: 'Your session has ended. Sign in again.',
  service_unavailable: 'Ombre is temporarily unavailable. Try again shortly.',
  network_error: 'Couldn’t reach Ombre. Check your connection and try again.',
}

export function messageForError(error) {
  if (error && MESSAGES[error.code]) return MESSAGES[error.code]
  return 'Something went wrong. Try again.'
}
