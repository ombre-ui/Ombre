// Cookie jar for the per-request Supabase server client.
//
// @supabase/ssr hands us cookies to write through setAll(). We never trust the attributes it passes:
// every Set-Cookie we emit is rebuilt here with the A2 policy (HttpOnly, SameSite=Lax, Path=/, no Domain,
// Secure in HTTPS modes, __Host- prefix in production) and a lifetime cap (session 30d, PKCE verifier 1h).

const COOKIE_NAME_RE = /^[A-Za-z0-9._-]+$/
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT'

export function parseCookieHeader(header) {
  if (typeof header !== 'string' || header === '') return []
  const out = []
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 1) continue
    const name = part.slice(0, idx).trim()
    if (!COOKIE_NAME_RE.test(name)) continue
    let value = part.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
    try {
      value = decodeURIComponent(value)
    } catch {
      // keep the raw value; ssr treats undecodable chunks as absent
    }
    out.push({ name, value })
  }
  return out
}

export function serializeSetCookie({ name, value, maxAge, secure }) {
  if (!COOKIE_NAME_RE.test(name)) throw new Error('invalid cookie name')
  if (name.startsWith('__Host-') && !secure) throw new Error('__Host- cookies require Secure')
  const expire = maxAge <= 0
  const parts = [
    `${name}=${expire ? '' : encodeURIComponent(value)}`,
    `Max-Age=${expire ? 0 : Math.floor(maxAge)}`,
  ]
  if (expire) parts.push(`Expires=${EPOCH}`)
  parts.push('Path=/', 'HttpOnly', 'SameSite=Lax')
  if (secure) parts.push('Secure')
  // Domain is deliberately never set (required for __Host-, and keeps cookies host-only everywhere).
  return parts.join('; ')
}

function isVerifierCookie(name) {
  return name.includes('-code-verifier')
}

export function createCookieJar({ request, config }) {
  const requestCookies = parseCookieHeader(request.headers.get('cookie'))
  const pending = new Map() // name -> { value, maxAge }
  const extraHeaders = {}

  function ownsName(name) {
    return name === config.cookieName || name.startsWith(config.cookieName)
  }

  return {
    getAll() {
      return requestCookies.map(({ name, value }) => ({ name, value }))
    },

    // Signature required by @supabase/ssr: setAll(cookiesToSet, headers)
    setAll(cookiesToSet, headers) {
      for (const { name, value, options } of cookiesToSet || []) {
        if (typeof name !== 'string' || !ownsName(name)) continue // never write foreign cookies
        const cap = isVerifierCookie(name) ? config.verifierMaxAge : config.sessionMaxAge
        const requested = options && typeof options.maxAge === 'number' ? options.maxAge : cap
        const expire = value === '' || requested <= 0
        pending.set(name, { value: expire ? '' : value, maxAge: expire ? 0 : Math.min(requested, cap) })
      }
      if (headers && typeof headers === 'object') Object.assign(extraHeaders, headers)
    },

    // Expire every auth cookie the browser sent (session chunks, PKCE verifier slots, stale chunks).
    expireAllAuthCookies() {
      for (const { name } of requestCookies) {
        if (ownsName(name)) pending.set(name, { value: '', maxAge: 0 })
      }
    },

    setCookieHeaders() {
      return Array.from(pending, ([name, { value, maxAge }]) =>
        serializeSetCookie({ name, value, maxAge, secure: config.secureCookies })
      )
    },

    extraHeaders() {
      return { ...extraHeaders }
    },

    hasPending() {
      return pending.size > 0
    },
  }
}
