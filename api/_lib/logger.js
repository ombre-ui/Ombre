// Structured, redacted server logging. Callers pass an explicit allow-list of safe fields;
// anything that looks sensitive is replaced anyway (defense in depth).

const SENSITIVE_KEY = /pass|token|secret|authorization|cookie|code|email|key|verifier|jwt|session|credential/i
// Fields the pipeline itself emits; their values are still scrubbed as strings.
const SAFE_KEYS = new Set(['requestId', 'method', 'path', 'status', 'durationMs', 'apiError', 'errName', 'errStatus', 'errCode'])
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g

export function scrub(value) {
  return String(value).replace(JWT, '[jwt]').replace(EMAIL, '[email]').replace(LONG_TOKEN, '[token]').slice(0, 200)
}

export function sanitizeFields(fields = {}) {
  const out = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (SENSITIVE_KEY.test(key) && !SAFE_KEYS.has(key)) {
      out[key] = '[redacted]'
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    } else if (typeof value === 'string') {
      out[key] = scrub(value)
    } else {
      out[key] = '[object]'
    }
  }
  return out
}

export function createLogger({ write = (line) => console.log(line), now = () => new Date() } = {}) {
  function emit(level, event, fields) {
    write(JSON.stringify({ ts: now().toISOString(), level, event, ...sanitizeFields(fields) }))
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  }
}

// Safe projection of an auth-js error for logs: name, status and code only. Never the message
// (it can contain an email address or token fragments).
export function describeAuthError(error) {
  if (!error) return {}
  return {
    errName: typeof error.name === 'string' ? error.name : undefined,
    errStatus: typeof error.status === 'number' ? error.status : undefined,
    errCode: typeof error.code === 'string' ? error.code : undefined,
  }
}
