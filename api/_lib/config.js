// Server-only configuration for the /api layer. Never imported by src/.
//
// Cookie policy (A2):
//   production / preview (HTTPS):  __Host-ombre-auth*  Secure; HttpOnly; Path=/; SameSite=Lax; no Domain
//   local development (http://localhost): ombre-auth*  HttpOnly; Path=/; SameSite=Lax (Secure only if HTTPS)
// The unprefixed local mode is only ever enabled when every allowed origin is a local http origin
// AND the runtime says it is development (VERCEL_ENV=development) or AUTH_ALLOW_INSECURE_COOKIES=true.

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60 // 30 days, maximum
export const VERIFIER_MAX_AGE_SECONDS = 60 * 60 // 1 hour

export const SECURE_COOKIE_NAME = '__Host-ombre-auth'
export const LOCAL_COOKIE_NAME = 'ombre-auth'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function parseOrigins(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError('APP_ORIGINS is required (comma separated exact origins).')
  }
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => {
      let url
      try {
        url = new URL(value)
      } catch {
        throw new ConfigError('APP_ORIGINS contains an invalid origin.')
      }
      const exact = url.origin
      if (/[*?\s]/.test(url.hostname) || value.includes('*')) {
        throw new ConfigError('APP_ORIGINS must not contain wildcards.')
      }
      // Must be an exact origin: no path, query, fragment, credentials or wildcard.
      if (value !== exact) {
        throw new ConfigError('APP_ORIGINS entries must be exact origins such as https://app.example.com.')
      }
      const local = isLocalHost(url.hostname)
      if (url.protocol === 'https:') return exact
      if (url.protocol === 'http:' && local) return exact
      throw new ConfigError('APP_ORIGINS entries must be https, or http on localhost.')
    })
  if (origins.length === 0) throw new ConfigError('APP_ORIGINS is required.')
  return Array.from(new Set(origins))
}

export function loadConfig(env = process.env) {
  const supabaseUrl = (env.SUPABASE_URL || '').trim()
  const supabasePublishableKey = (env.SUPABASE_PUBLISHABLE_KEY || '').trim()
  if (!supabaseUrl) throw new ConfigError('SUPABASE_URL is required.')
  if (!supabasePublishableKey) throw new ConfigError('SUPABASE_PUBLISHABLE_KEY is required.')

  let supaUrl
  try {
    supaUrl = new URL(supabaseUrl)
  } catch {
    throw new ConfigError('SUPABASE_URL is not a valid URL.')
  }
  if (supaUrl.protocol !== 'https:' && !(supaUrl.protocol === 'http:' && isLocalHost(supaUrl.hostname))) {
    throw new ConfigError('SUPABASE_URL must be https (or http on localhost).')
  }

  // A secret/service-role key must never be configured here (defense in depth).
  if (/^sb_secret_/.test(supabasePublishableKey)) {
    throw new ConfigError('SUPABASE_PUBLISHABLE_KEY must be a publishable key, not a secret key.')
  }
  const jwtRole = decodeJwtRole(supabasePublishableKey)
  if (jwtRole && jwtRole !== 'anon') {
    throw new ConfigError('SUPABASE_PUBLISHABLE_KEY must be a publishable/anon key.')
  }

  const appOrigins = parseOrigins(env.APP_ORIGINS)
  const allLocalHttp = appOrigins.every((o) => o.startsWith('http://'))

  if (env.VERCEL_ENV === 'production' && appOrigins.some((o) => o.startsWith('http://'))) {
    throw new ConfigError('Local http origins are not allowed in production.')
  }

  const devRequested = env.VERCEL_ENV === 'development' || env.AUTH_ALLOW_INSECURE_COOKIES === 'true'
  const insecureCookies = devRequested && allLocalHttp
  const secureCookies = !insecureCookies

  return Object.freeze({
    supabaseUrl: supaUrl.origin,
    supabasePublishableKey,
    appOrigins: Object.freeze(appOrigins),
    secureCookies,
    cookieName: secureCookies ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME,
    sessionMaxAge: SESSION_MAX_AGE_SECONDS,
    verifierMaxAge: VERIFIER_MAX_AGE_SECONDS,
  })
}

function decodeJwtRole(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}
