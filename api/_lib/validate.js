import { badRequest } from './errors.js'

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_BYTES = 72 // bcrypt limit used by Supabase Auth
export const EMAIL_MAX_LENGTH = 254
export const DISPLAY_NAME_MAX_LENGTH = 100 // characters; mirrors the profiles.display_name check constraint

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/
const CODE_RE = /^[A-Za-z0-9._~-]{8,256}$/
const FLOW_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
// C0/C1 control characters plus line/paragraph separators: a display name is one line of plain text.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/

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

// A display name is a trimmed single line of 1..100 characters, or null (cleared).
// Empty or whitespace-only input clears the name. Length is counted in characters (code points),
// matching Postgres char_length, not UTF-16 units.
export function parseDisplayName(value) {
  if (value === null) return null
  if (typeof value !== 'string') throw badRequest()
  const name = value.normalize('NFC').trim()
  if (name === '') return null
  if (CONTROL_CHARS_RE.test(name)) throw badRequest()
  if (Array.from(name).length > DISPLAY_NAME_MAX_LENGTH) throw badRequest()
  return name
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
