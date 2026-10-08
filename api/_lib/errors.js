// Generic, client-safe API errors. Provider/internal details never reach the response body.

const MESSAGES = {
  invalid_request: 'The request was not valid.',
  invalid_credentials: 'Email or password is incorrect.',
  email_not_confirmed: 'Confirm your email address to sign in.',
  weak_password: 'Choose a longer or stronger password.',
  same_password: 'Choose a password you have not used before.',
  recent_login_required: 'Sign in again, then retry.',
  unauthenticated: 'You need to sign in.',
  forbidden: 'This request was not allowed.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  payload_too_large: 'The request was too large.',
  unsupported_media_type: 'Unsupported content type.',
  rate_limited: 'Too many attempts. Try again later.',
  link_invalid_or_expired: 'This link is invalid or has expired.',
  link_wrong_browser: 'Open the link in the same browser you used to request it.',
  signup_failed: 'We could not create the account.',
  reset_failed: 'We could not update the password.',
  service_unavailable: 'Ombre is temporarily unavailable. Try again shortly.',
  internal_error: 'Something went wrong.',
}

export class ApiError extends Error {
  constructor(status, code, options = {}) {
    super(code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.headers = options.headers || null
    this.cause = options.cause
  }
  get publicMessage() {
    return MESSAGES[this.code] || MESSAGES.internal_error
  }
}

export const badRequest = (code = 'invalid_request') => new ApiError(400, code)
export const unauthorized = (code = 'unauthenticated') => new ApiError(401, code)
export const forbidden = (code = 'forbidden') => new ApiError(403, code)
export const tooManyRequests = () => new ApiError(429, 'rate_limited')
export const unavailable = () => new ApiError(503, 'service_unavailable')
export const methodNotAllowed = (allow) =>
  new ApiError(405, 'method_not_allowed', { headers: { Allow: allow.join(', ') } })

// ---- classification of errors coming back from @supabase/auth-js ----

export function isRetryable(error) {
  if (!error) return false
  if (error.name === 'AuthRetryableFetchError') return true
  return typeof error.status === 'number' && (error.status === 0 || error.status >= 500)
}

export function isRateLimited(error) {
  if (!error) return false
  if (error.status === 429) return true
  return typeof error.code === 'string' && /rate_limit/.test(error.code)
}

export function isSessionMissing(error) {
  return Boolean(error) && error.name === 'AuthSessionMissingError'
}

export function isVerifierMissing(error) {
  if (!error) return false
  if (error.name === 'AuthPKCECodeVerifierMissingError') return true
  return typeof error.message === 'string' && /code verifier/i.test(error.message)
}
