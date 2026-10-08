import { badRequest } from './errors.js'

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_BYTES = 72 // bcrypt limit used by Supabase Auth
export const EMAIL_MAX_LENGTH = 254

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/
const CODE_RE = /^[A-Za-z0-9._~-]{8,256}$/
const FLOW_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

export function parseEmail(value) {
  if (typeof value !== 'string') throw badRequest()
  const email = value.trim().toLowerCase()
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) throw badRequest()
  return email
}

// For sign-in we only bound the input; policy (minimum length) applies when a password is set.
export function parseExistingPassword(value) {
  if (typeof value !== 'string' || value.length === 0) throw badRequest()
  if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) throw badRequest()
  return value
}

export function parseNewPassword(value) {
  if (typeof value !== 'string') throw badRequest()
  if (Array.from(value).length < PASSWORD_MIN_LENGTH) throw badRequest('weak_password')
  if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) throw badRequest('weak_password')
  return value
}

export function parseAuthCode(value) {
  if (typeof value !== 'string' || !CODE_RE.test(value)) throw badRequest('link_invalid_or_expired')
  return value
}

export function parseFlowId(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !FLOW_ID_RE.test(value)) throw badRequest('link_invalid_or_expired')
  return value
}

export function parsePurpose(value) {
  if (value === undefined || value === null) return null
  if (value === 'recovery' || value === 'signup') return value
  throw badRequest()
}

export function parseJsonObject(text, allowedKeys) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw badRequest()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest()
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.includes(key)) throw badRequest() // unknown keys are rejected, never ignored
  }
  return parsed
}
