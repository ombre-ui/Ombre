import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRoutes, makeRequest, json, ORIGIN } from './helpers.js'
import { OAUTH_PROVIDERS, parseOAuthProvider } from '../../api/_lib/validate.js'

const AUTHORIZE = 'https://abc.supabase.co/auth/v1/authorize?provider=google&code_challenge=CHALLENGE&code_challenge_method=s256'
const start = (body, extra = {}) => makeRequest('/api/auth/oauth', { body, ...extra })

function recorder(url = AUTHORIZE) {
  const calls = []
  return { calls, auth: { signInWithOAuth: async (args) => { calls.push(args); return { data: { provider: args.provider, url }, error: null } } } }
}

test('the provider allow-list is exactly github and google', () => {
  assert.deepEqual([...OAUTH_PROVIDERS], ['github', 'google'])
  assert.equal(parseOAuthProvider('google'), 'google')
  assert.equal(parseOAuthProvider('github'), 'github')
  for (const bad of ['Google', 'GOOGLE', 'google ', 'facebook', 'apple', 'azure', '', null, undefined, 1, {}, ['google']]) {
    assert.throws(() => parseOAuthProvider(bad), (e) => e.status === 400, String(bad))
  }
})

test('Google start: same server-side PKCE pattern, same validated redirect, Google account chooser requested by the server', async () => {
  const { calls, auth } = recorder()
  const { routes } = buildRoutes({ auth })
  const res = await routes.oauth(start({ provider: 'google' }))
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { ok: true, url: AUTHORIZE })
  assert.deepEqual(calls, [{ provider: 'google', options: { redirectTo: `${ORIGIN}/auth/callback/oauth`, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } } }])
})

test('regression: GitHub start is byte-for-byte what it was (no extra query params)', async () => {
  const { calls, auth } = recorder('https://abc.supabase.co/auth/v1/authorize?provider=github')
  const { routes } = buildRoutes({ auth })
  const res = await routes.oauth(start({ provider: 'github' }))
  assert.equal(res.status, 200)
  assert.deepEqual(calls, [{ provider: 'github', options: { redirectTo: `${ORIGIN}/auth/callback/oauth`, skipBrowserRedirect: true } }])
})

test('the browser can never choose the redirect, scopes or query parameters', async () => {
  for (const body of [
    { provider: 'google', redirectTo: 'https://evil.example/cb' },
    { provider: 'google', queryParams: { prompt: 'none' } },
    { provider: 'google', scopes: 'https://www.googleapis.com/auth/drive' },
    { provider: 'google', options: { redirectTo: 'https://evil.example' } },
    { provider: 'google', next: 'https://evil.example' },
  ]) {
    const { calls, auth } = recorder()
    const { routes } = buildRoutes({ auth })
    assert.equal((await routes.oauth(start(body))).status, 400, JSON.stringify(body))
    assert.equal(calls.length, 0)
  }
})

test('Google start keeps every protection: CSRF, exact Origin, POST only, pinned authorize URL', async () => {
  const { calls, auth } = recorder()
  const { routes } = buildRoutes({ auth })
  assert.equal((await routes.oauth(start({ provider: 'google' }, { origin: 'https://evil.example' }))).status, 403)
  assert.equal((await routes.oauth(start({ provider: 'google' }, { csrf: false }))).status, 403)
  assert.equal((await routes.oauth(makeRequest('/api/auth/oauth', { method: 'GET', origin: undefined, csrf: false }))).status, 405)
  assert.equal(calls.length, 0)
  const evil = recorder('https://accounts.google.com/o/oauth2/v2/auth?client_id=x') // Google's own URL must not be handed out directly
  const r2 = buildRoutes({ auth: evil.auth })
  const res = await r2.routes.oauth(start({ provider: 'google' }))
  assert.equal(res.status, 500)
  assert.ok(!(await res.text()).includes('accounts.google.com'))
})

test('Google start: the PKCE verifier cookie is propagated HttpOnly/Secure and never appears in the body or logs', async () => {
  const { auth } = recorder()
  const emitCookies = (jar, cfg) => jar.setAll([{ name: `${cfg.cookieName}-code-verifier`, value: 'google-verifier-value', options: { maxAge: 31536000 } }])
  const { routes, lines } = buildRoutes({ auth, emitCookies })
  const res = await routes.oauth(start({ provider: 'google' }))
  const cookies = res.headers.getSetCookie()
  assert.equal(cookies.length, 1)
  assert.match(cookies[0], /HttpOnly/)
  assert.match(cookies[0], /Secure/)
  assert.ok(!(await res.clone().text()).includes('google-verifier-value'))
  assert.ok(lines.every((l) => !l.includes('google-verifier-value') && !l.includes('CHALLENGE')))
})

test('Google errors map exactly like GitHub: outage 503, rate limit 429, otherwise a generic oauth_failed', async () => {
  for (const [error, status, code] of [
    [{ name: 'AuthRetryableFetchError', status: 0, message: 'secret' }, 503, 'service_unavailable'],
    [{ name: 'AuthApiError', status: 429, code: 'over_request_rate_limit', message: 'secret' }, 429, 'rate_limited'],
    [{ name: 'AuthApiError', status: 400, code: 'validation_failed', message: 'provider is not enabled secret' }, 400, 'oauth_failed'],
  ]) {
    const { routes, lines } = buildRoutes({ auth: { signInWithOAuth: async () => ({ data: { url: null }, error }) } })
    const res = await routes.oauth(start({ provider: 'google' }))
    const text = await res.text()
    assert.equal(res.status, status)
    assert.equal(JSON.parse(text).error.code, code)
    assert.ok(!/secret/.test(text) && lines.every((l) => !/secret/.test(l)))
  }
})

test('Google callback outcome: the same oauth purpose signs the user in and goes to the app; failures stay generic', async () => {
  const ok = buildRoutes({ auth: { exchangeCodeForSession: async () => ({ data: { user: { id: 'g1', email: 'person@gmail.com' }, session: null }, error: null }) } })
  const res = await ok.routes.callback(makeRequest('/api/auth/callback', { body: { code: 'abcdefgh12345678', purpose: 'oauth' } }))
  assert.deepEqual(await json(res), { ok: true, next: '/app/general', user: { id: 'g1', email: 'person@gmail.com' } })
  const bad = buildRoutes({ auth: { exchangeCodeForSession: async () => ({ data: { user: null, session: null }, error: { name: 'AuthApiError', status: 400, code: 'bad_oauth_state', message: 'secret' } }) } })
  const r2 = await bad.routes.callback(makeRequest('/api/auth/callback', { body: { code: 'abcdefgh12345678', purpose: 'oauth' } }))
  assert.equal(r2.status, 400)
  assert.ok(!(await r2.text()).includes('secret'))
})
