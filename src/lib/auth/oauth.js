// Pure helpers for "Continue with <provider>". No tokens, secrets or storage: the server starts the Supabase OAuth
// (PKCE) flow and the browser only receives the provider authorize URL, then later a one-time `code`.

export const OAUTH_PROVIDERS = ['github', 'google']

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// The browser only follows https authorize URLs (http only on localhost for `supabase start`) that point at
// Supabase's authorize endpoint. The server already pins the exact Supabase origin; this is a second,
// independent check on scheme and path (the client does not know the Supabase host).
export function isSafeAuthorizeUrl(value) {
  if (typeof value !== 'string') return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const protocolOk = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))
  return protocolOk && url.pathname === '/auth/v1/authorize'
}

// request: apiRequest, assign: (url) => window.location.assign(url). Both injected so this is testable.
export async function startOAuthRequest(provider, { request, assign }) {
  if (!OAUTH_PROVIDERS.includes(provider)) return { ok: false, status: 0, error: { code: 'oauth_failed', message: '' } }
  const result = await request('/api/auth/oauth', { method: 'POST', body: { provider } })
  if (!result.ok) return result
  const url = result.data && result.data.url
  if (!isSafeAuthorizeUrl(url)) return { ok: false, status: 0, error: { code: 'oauth_failed', message: '' } }
  assign(url)
  return result
}

// Interprets what the provider/Supabase put on the callback URL. Only the *kind* is returned for errors:
// error descriptions are never shown or logged.
//   { kind: 'code', code, flowId }   a one-time authorization code to exchange
//   { kind: 'cancelled' }            the user declined at the provider
//   { kind: 'expired' }              invalid/expired OAuth state
//   { kind: 'failed' }               anything else
export function classifyReturn(search, hash) {
  const error = search.get('error') || hash.get('error')
  const errorCode = search.get('error_code') || hash.get('error_code')
  if (error || errorCode) {
    if (error === 'access_denied') return { kind: 'cancelled' }
    if (errorCode === 'bad_oauth_state' || errorCode === 'bad_oauth_callback') return { kind: 'expired' }
    return { kind: 'failed' }
  }
  const code = search.get('code')
  if (!code) return { kind: 'failed' }
  return { kind: 'code', code, flowId: search.get('sb_flow_id') }
}
