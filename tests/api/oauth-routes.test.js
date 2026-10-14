import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRoutes, makeRequest, json, ORIGIN, devConfig } from './helpers.js'

const AUTHORIZE = 'https://abc.supabase.co/auth/v1/authorize?provider=github&redirect_to=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback%2Foauth&code_challenge=CHALLENGE&code_challenge_method=s256'
const VERIFIER_COOKIE = (cfg) => `${cfg.cookieName}-code-verifier`

function okAuth(calls = []) {
  return {
    signInWithOAuth: async (args) => {
      calls.push(args)
      return { data: { provider: args.provider, url: AUTHORIZE }, error: null }
    },
  }
}
const start = (body, extra = {}) => makeRequest('/api/auth/oauth', { body, ...extra })

test('starts GitHub OAuth: PKCE via the server client, redirectTo from the validated Origin, authorize URL returned', async () => {
  const calls = []
  const { routes } = buildRoutes({ auth: okAuth(calls) })
  const res = await routes.oauth(start({ provider: 'github' }))
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { ok: true, url: AUTHORIZE })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { provider: 'github', options: { redirectTo: `${ORIGIN}/auth/callback/oauth`, skipBrowserRedirect: true } })
  assert.match(res.headers.get('cache-control'), /no-store/)
})

test('the PKCE verifier cookie set during start is propagated as an HttpOnly, Secure, __Host- cookie', async () => {
  const emitCookies = (jar, cfg) => jar.setAll([{ name: VERIFIER_COOKIE(cfg), value: 'verifier-value', options: { maxAge: 31536000 } }])
  const { routes } = buildRoutes({ auth: okAuth(), emitCookies })
  const res = await routes.oauth(start({ provider: 'github' }))
  const cookies = res.headers.getSetCookie()
  assert.equal(cookies.length, 1)
  assert.match(cookies[0], /^__Host-ombre-auth-code-verifier=verifier-value; Max-Age=3600; Path=\/; HttpOnly; SameSite=Lax; Secure$/) // capped at one hour
  assert.ok(!(await res.clone().text()).includes('verifier-value'), 'the verifier never appears in the body')
})

test('local development uses the local origin and an insecure-cookie-capable config', async () => {
  const calls = []
  const config = devConfig()
  const { routes } = buildRoutes({ auth: { signInWithOAuth: async (a) => { calls.push(a); return { data: { url: 'http://127.0.0.1:54321/auth/v1/authorize?provider=github' }, error: null } } }, config })
  const res = await routes.oauth(makeRequest('/api/auth/oauth', { body: { provider: 'github' }, origin: 'http://localhost:3000' }))
  assert.equal(res.status, 200)
  assert.equal(calls[0].options.redirectTo, 'http://localhost:3000/auth/callback/oauth')
})

test('only allow-listed providers are accepted; unknown keys and bad shapes are 400 and never reach Supabase', async () => {
  for (const body of [{ provider: 'google' }, { provider: 'GitHub' }, { provider: '' }, { provider: 5 }, { provider: null }, {}, { provider: 'github', redirectTo: 'https://evil.example' }, { provider: 'github', scopes: 'repo' }]) {
    const calls = []
    const { routes } = buildRoutes({ auth: okAuth(calls) })
    const res = await routes.oauth(start(body))
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(calls.length, 0, JSON.stringify(body))
  }
})

test('CSRF protection: exact Origin and the custom header are required; GET is not allowed', async () => {
  const calls = []
  const { routes } = buildRoutes({ auth: okAuth(calls) })
  assert.equal((await routes.oauth(start({ provider: 'github' }, { origin: 'https://evil.example' }))).status, 403)
  assert.equal((await routes.oauth(start({ provider: 'github' }, { origin: undefined }))).status, 403)
  assert.equal((await routes.oauth(start({ provider: 'github' }, { csrf: false }))).status, 403)
  const get = await routes.oauth(makeRequest('/api/auth/oauth', { method: 'GET', origin: undefined, csrf: false }))
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
  assert.equal(calls.length, 0)
})

test('an authorize URL that is not this project\'s Supabase endpoint is never returned to the browser', async () => {
  for (const url of ['https://evil.example/auth/v1/authorize?x=1', 'https://abc.supabase.co.evil.example/auth/v1/authorize', 'https://abc.supabase.co/other/path', 'javascript:alert(1)', 'not a url', undefined, null, 42]) {
    const { routes, lines } = buildRoutes({ auth: { signInWithOAuth: async () => ({ data: { url }, error: null }) } })
    const res = await routes.oauth(start({ provider: 'github' }))
    const text = await res.text()
    assert.equal(res.status, 500, String(url))
    assert.equal(JSON.parse(text).error.code, 'internal_error')
    assert.ok(!text.includes('evil.example') && !text.includes('javascript'))
    assert.ok(lines.every((l) => !l.includes('evil.example')))
  }
})

test('errors: outage 503, rate limit 429, anything else a generic oauth_failed with no provider detail', async () => {
  const cases = [
    [{ name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed secret' }, 503, 'service_unavailable'],
    [{ name: 'AuthApiError', status: 429, code: 'over_request_rate_limit', message: 'secret' }, 429, 'rate_limited'],
    [{ name: 'AuthApiError', status: 400, code: 'validation_failed', message: 'Unsupported provider: provider is not enabled secret-detail' }, 400, 'oauth_failed'],
  ]
  for (const [error, status, code] of cases) {
    const { routes, lines } = buildRoutes({ auth: { signInWithOAuth: async () => ({ data: { provider: 'github', url: null }, error }) } })
    const res = await routes.oauth(start({ provider: 'github' }))
    const text = await res.text()
    assert.equal(res.status, status)
    assert.equal(JSON.parse(text).error.code, code)
    assert.ok(!/secret/.test(text))
    assert.ok(lines.every((l) => !/secret/.test(l)), 'logs carry name/status/code only')
  }
})

test('logs never contain the authorize URL, the code challenge or the redirect target', async () => {
  const { routes, lines } = buildRoutes({ auth: okAuth() })
  await routes.oauth(start({ provider: 'github' }))
  const all = lines.join('\n')
  assert.ok(!all.includes('CHALLENGE') && !all.includes('authorize') && !all.includes('supabase.co'))
})

test('callback accepts the oauth purpose, signs the user in and goes to the app (no password step, no email confirmation)', async () => {
  const exchanged = []
  const auth = {
    exchangeCodeForSession: async (code, opts) => {
      exchanged.push([code, opts])
      return { data: { user: { id: 'u1', email: 'dev@example.com' }, session: { user: { id: 'u1' } } }, error: null }
    },
  }
  const { routes } = buildRoutes({ auth })
  const res = await routes.callback(makeRequest('/api/auth/callback', { body: { code: 'abcdefgh12345678', purpose: 'oauth' } }))
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { ok: true, next: '/app/general', user: { id: 'u1', email: 'dev@example.com' } })
  assert.deepEqual(exchanged, [['abcdefgh12345678', undefined]])
})

test('callback: an OAuth user with no public email still signs in (email null), and unknown purposes are rejected', async () => {
  const auth = { exchangeCodeForSession: async () => ({ data: { user: { id: 'u2', email: undefined }, session: null }, error: null }) }
  const { routes } = buildRoutes({ auth })
  const ok = await routes.callback(makeRequest('/api/auth/callback', { body: { code: 'abcdefgh12345678', purpose: 'oauth' } }))
  assert.deepEqual((await json(ok)).user, { id: 'u2', email: null })
  assert.equal((await routes.callback(makeRequest('/api/auth/callback', { body: { code: 'abcdefgh12345678', purpose: 'admin' } }))).status, 400)
})

test('callback failures stay generic: missing verifier (other browser), expired/invalid state, outage', async () => {
  const cases = [
    [{ name: 'AuthPKCECodeVerifierMissingError', message: 'PKCE code verifier not found in storage' }, 400, 'link_wrong_browser'],
    [{ name: 'AuthApiError', status: 400, code: 'bad_oauth_state', message: 'OAuth state is invalid secret' }, 400, 'link_invalid_or_expired'],
    [{ name: 'AuthRetryableFetchError', status: 0, message: 'secret' }, 503, 'service_unavailable'],
  ]
  for (const [error, status, code] of cases) {
    const { routes, lines } = buildRoutes({ auth: { exchangeCodeForSession: async () => ({ data: { user: null, session: null }, error }) } })
    const res = await routes.callback(makeRequest('/api/auth/callback', { body: { code: 'abcdefgh12345678', purpose: 'oauth' } }))
    const text = await res.text()
    assert.equal(res.status, status)
    assert.equal(JSON.parse(text).error.code, code)
    assert.ok(!/secret|PKCE|OAuth state/.test(text))
    assert.ok(lines.every((l) => !/secret|abcdefgh12345678/.test(l)), 'the authorization code is never logged')
  }
})
