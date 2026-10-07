import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRoutes, makeRequest, json, ORIGIN, prodConfig } from './helpers.js'

const PW = 'correct horse battery'
const user = { id: 'u1', email: 'a@example.com', app_metadata: { secret: 'x' }, identities: [{}] }
const authErr = (o) => Object.assign(new Error('provider message with a@example.com'), { name: 'AuthApiError', ...o })

test('session: no cookie -> user null, 200', async () => {
  const { routes } = buildRoutes({ auth: { getUser: async () => ({ data: { user: null }, error: Object.assign(new Error('x'), { name: 'AuthSessionMissingError', status: 400 }) }) } })
  const res = await routes.session(makeRequest('/api/auth/session', { method: 'GET', origin: undefined, csrf: false }))
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { user: null })
  assert.equal(res.headers.getSetCookie().length, 0)
})

test('session: valid user -> only id and email are returned', async () => {
  const { routes } = buildRoutes({ auth: { getUser: async () => ({ data: { user }, error: null }) } })
  const res = await routes.session(makeRequest('/api/auth/session', { method: 'GET', origin: undefined, csrf: false }))
  assert.deepEqual(await json(res), { user: { id: 'u1', email: 'a@example.com' } })
})

test('session: invalid/revoked session clears every auth cookie', async () => {
  const cookie = ['__Host-ombre-auth.0=a', '__Host-ombre-auth.1=b'].join('; ')
  const { routes } = buildRoutes({ auth: { getUser: async () => ({ data: { user: null }, error: authErr({ status: 400, code: 'refresh_token_not_found' }) }) } })
  const res = await routes.session(makeRequest('/api/auth/session', { method: 'GET', origin: undefined, csrf: false, cookie }))
  assert.deepEqual(await json(res), { user: null })
  const set = res.headers.getSetCookie()
  assert.equal(set.length, 2)
  assert.ok(set.every((c) => c.includes('Max-Age=0')))
})

test('session: provider outage is a 503 and does NOT clear the session', async () => {
  const cookie = '__Host-ombre-auth.0=a'
  const { routes } = buildRoutes({ auth: { getUser: async () => ({ data: { user: null }, error: Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 }) }) } })
  const res = await routes.session(makeRequest('/api/auth/session', { method: 'GET', origin: undefined, csrf: false, cookie }))
  assert.equal(res.status, 503)
  assert.equal(res.headers.getSetCookie().length, 0)
})

test('session cookie written by the auth client is delivered with the A2 policy (rotation path)', async () => {
  const { routes } = buildRoutes({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    emitCookies: (jar, cfg) => jar.setAll([{ name: `${cfg.cookieName}.0`, value: 'base64-new', options: { maxAge: 34560000, httpOnly: false } }], { 'Cache-Control': 'private, no-store' }),
  })
  const res = await routes.session(makeRequest('/api/auth/session', { method: 'GET', origin: undefined, csrf: false }))
  const [c] = res.headers.getSetCookie()
  assert.ok(c.startsWith('__Host-ombre-auth.0=') && c.includes('HttpOnly') && c.includes('Secure') && c.includes('SameSite=Lax') && c.includes(`Max-Age=${30 * 86400}`))
})

test('signin: success returns id/email only', async () => {
  const { routes } = buildRoutes({ auth: { signInWithPassword: async () => ({ data: { user, session: {} }, error: null }) } })
  const res = await routes.signin(makeRequest('/api/auth/signin', { body: { email: 'A@Example.com', password: PW } }))
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { ok: true, user: { id: 'u1', email: 'a@example.com' } })
})

test('signin: wrong password, unknown user and provider internals all look identical', async () => {
  for (const error of [authErr({ status: 400, code: 'invalid_credentials' }), authErr({ status: 400, code: 'user_not_found' }), authErr({ status: 422, code: 'whatever' })]) {
    const { routes, lines } = buildRoutes({ auth: { signInWithPassword: async () => ({ data: {}, error }) } })
    const res = await routes.signin(makeRequest('/api/auth/signin', { body: { email: 'a@example.com', password: PW } }))
    const text = await res.text()
    assert.equal(res.status, 401)
    assert.equal(JSON.parse(text).error.code, 'invalid_credentials')
    assert.ok(!text.includes('provider message'))
    assert.ok(lines.every((l) => !l.includes('a@example.com') && !l.includes(PW)))
    assert.equal(res.headers.getSetCookie().length, 0)
  }
})

test('signin: unconfirmed, rate limit and outage are distinguished safely', async () => {
  const cases = [
    [authErr({ status: 400, code: 'email_not_confirmed' }), 403, 'email_not_confirmed'],
    [authErr({ status: 429, code: 'over_request_rate_limit' }), 429, 'rate_limited'],
    [Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 }), 503, 'service_unavailable'],
  ]
  for (const [error, status, code] of cases) {
    const { routes } = buildRoutes({ auth: { signInWithPassword: async () => ({ data: {}, error }) } })
    const res = await routes.signin(makeRequest('/api/auth/signin', { body: { email: 'a@example.com', password: PW } }))
    assert.equal(res.status, status)
    assert.equal((await json(res)).error.code, code)
  }
})

test('signin: invalid input never reaches the provider', async () => {
  let called = 0
  const { routes } = buildRoutes({ auth: { signInWithPassword: async () => { called++; return { data: {}, error: null } } } })
  for (const body of [{ email: 'nope', password: PW }, { email: 'a@example.com' }, { email: 'a@example.com', password: '' }, { email: 'a@example.com', password: PW, extra: 1 }]) {
    assert.equal((await routes.signin(makeRequest('/api/auth/signin', { body }))).status, 400)
  }
  assert.equal(called, 0)
})

test('signup: enforces 12 chars, uses the validated origin for the PKCE redirect, identical response for existing users', async () => {
  let args
  const { routes } = buildRoutes({ auth: { signUp: async (a) => { args = a; return { data: { user, session: null }, error: null } } } })
  const short = await routes.signup(makeRequest('/api/auth/signup', { body: { email: 'a@example.com', password: 'short' } }))
  assert.equal(short.status, 400)
  assert.equal((await json(short)).error.code, 'weak_password')
  assert.equal(args, undefined)

  const ok = await routes.signup(makeRequest('/api/auth/signup', { body: { email: 'a@example.com', password: PW } }))
  assert.deepEqual(await json(ok), { ok: true, status: 'check_email' })
  assert.equal(args.options.emailRedirectTo, `${ORIGIN}/auth/callback`)

  const dup = buildRoutes({ auth: { signUp: async () => ({ data: {}, error: authErr({ status: 422, code: 'user_already_exists' }) }) } })
  const res = await dup.routes.signup(makeRequest('/api/auth/signup', { body: { email: 'a@example.com', password: PW } }))
  assert.deepEqual(await json(res), { ok: true, status: 'check_email' })
})

test('signup: provider weak-password and failures map to generic codes', async () => {
  const w = buildRoutes({ auth: { signUp: async () => ({ data: {}, error: authErr({ status: 422, code: 'weak_password' }) }) } })
  assert.equal((await json(await w.routes.signup(makeRequest('/api/auth/signup', { body: { email: 'a@example.com', password: PW } })))).error.code, 'weak_password')
  const f = buildRoutes({ auth: { signUp: async () => ({ data: {}, error: authErr({ status: 400, code: 'signup_disabled' }) }) } })
  const res = await f.routes.signup(makeRequest('/api/auth/signup', { body: { email: 'a@example.com', password: PW } }))
  assert.equal(res.status, 400)
  assert.equal((await json(res)).error.code, 'signup_failed')
})

test('forgot-password: always the same answer; recovery redirect path; rate limits surface', async () => {
  let args
  const ok = buildRoutes({ auth: { resetPasswordForEmail: async (e, o) => { args = [e, o]; return { data: {}, error: null } } } })
  const a = await ok.routes.forgotPassword(makeRequest('/api/auth/forgot-password', { body: { email: 'a@example.com' } }))
  assert.deepEqual(await json(a), { ok: true })
  assert.equal(args[1].redirectTo, `${ORIGIN}/auth/callback/recovery`)
  const unknown = buildRoutes({ auth: { resetPasswordForEmail: async () => ({ data: {}, error: authErr({ status: 400, code: 'user_not_found' }) }) } })
  const b = await unknown.routes.forgotPassword(makeRequest('/api/auth/forgot-password', { body: { email: 'x@example.com' } }))
  assert.deepEqual(await json(b), { ok: true })
  const limited = buildRoutes({ auth: { resetPasswordForEmail: async () => ({ data: {}, error: authErr({ status: 429, code: 'over_email_send_rate_limit' }) }) } })
  assert.equal((await limited.routes.forgotPassword(makeRequest('/api/auth/forgot-password', { body: { email: 'x@example.com' } }))).status, 429)
})

test('callback: exchanges the code (PKCE), routes recovery to /reset-password, signup to the app', async () => {
  const calls = []
  const exchange = async (code, opts) => { calls.push([code, opts]); return { data: { user, session: { user } }, error: null } }
  const { routes } = buildRoutes({ auth: { exchangeCodeForSession: exchange } })
  const code = '2f1c9a5e-0b7d-4c1e-9f3a-123456789abc'
  const signup = await routes.callback(makeRequest('/api/auth/callback', { body: { code } }))
  assert.deepEqual(await json(signup), { ok: true, next: '/app/general', user: { id: 'u1', email: 'a@example.com' } })
  const recovery = await routes.callback(makeRequest('/api/auth/callback', { body: { code, purpose: 'recovery' } }))
  assert.equal((await json(recovery)).next, '/reset-password')
  const typed = buildRoutes({ auth: { exchangeCodeForSession: async () => ({ data: { user, session: { user }, redirectType: 'PASSWORD_RECOVERY' }, error: null }) } })
  assert.equal((await json(await typed.routes.callback(makeRequest('/api/auth/callback', { body: { code } })))).next, '/reset-password')
  assert.deepEqual(calls[0], [code, undefined])
  await routes.callback(makeRequest('/api/auth/callback', { body: { code, flowId: 'abcdefgh12345678' } }))
  assert.deepEqual(calls[2], [code, { flowId: 'abcdefgh12345678' }])
})

test('callback: next is never taken from the client', async () => {
  const { routes } = buildRoutes({ auth: { exchangeCodeForSession: async () => ({ data: { user, session: { user } }, error: null }) } })
  const code = '2f1c9a5e-0b7d-4c1e-9f3a-123456789abc'
  const res = await routes.callback(makeRequest('/api/auth/callback', { body: { code, next: 'https://evil.example' } }))
  assert.equal(res.status, 400) // unknown key rejected
})

test('callback: failures are generic; wrong browser (missing verifier) is distinguishable; outage is 503', async () => {
  const code = '2f1c9a5e-0b7d-4c1e-9f3a-123456789abc'
  const mk = (error) => buildRoutes({ auth: { exchangeCodeForSession: async () => ({ data: { user: null, session: null }, error }) } })
  const expired = await mk(authErr({ status: 400, code: 'flow_state_expired' })).routes.callback(makeRequest('/api/auth/callback', { body: { code } }))
  assert.equal((await json(expired)).error.code, 'link_invalid_or_expired')
  const wrong = await mk(Object.assign(new Error('PKCE code verifier not found in storage'), { name: 'AuthPKCECodeVerifierMissingError', status: 400 })).routes.callback(makeRequest('/api/auth/callback', { body: { code } }))
  assert.equal((await json(wrong)).error.code, 'link_wrong_browser')
  const down = await mk(Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 })).routes.callback(makeRequest('/api/auth/callback', { body: { code } }))
  assert.equal(down.status, 503)
  const bad = await mk(null).routes.callback(makeRequest('/api/auth/callback', { body: { code: 'x' } }))
  assert.equal(bad.status, 400)
})

test('reset-password: requires a validated session (getUser), 12+ chars, maps provider errors', async () => {
  let updated = 0
  const anon = buildRoutes({ auth: { getUser: async () => ({ data: { user: null }, error: authErr({ status: 401 }) }), updateUser: async () => { updated++ } } })
  assert.equal((await anon.routes.resetPassword(makeRequest('/api/auth/reset-password', { body: { password: PW } }))).status, 401)
  assert.equal(updated, 0)

  const ok = buildRoutes({ auth: { getUser: async () => ({ data: { user }, error: null }), updateUser: async () => { updated++; return { data: {}, error: null } } } })
  assert.equal((await ok.routes.resetPassword(makeRequest('/api/auth/reset-password', { body: { password: 'short' } }))).status, 400)
  assert.equal(updated, 0)
  assert.deepEqual(await json(await ok.routes.resetPassword(makeRequest('/api/auth/reset-password', { body: { password: PW } }))), { ok: true })
  assert.equal(updated, 1)

  for (const [code, status, apiCode] of [['same_password', 400, 'same_password'], ['weak_password', 400, 'weak_password'], ['reauthentication_needed', 403, 'recent_login_required'], ['other', 400, 'reset_failed']]) {
    const r = buildRoutes({ auth: { getUser: async () => ({ data: { user }, error: null }), updateUser: async () => ({ data: {}, error: authErr({ status: 422, code }) }) } })
    const res = await r.routes.resetPassword(makeRequest('/api/auth/reset-password', { body: { password: PW } }))
    assert.equal(res.status, status)
    assert.equal((await json(res)).error.code, apiCode)
  }
})

test('signout: revokes locally, expires every cookie even if the provider errors, requires CSRF', async () => {
  const cookie = ['__Host-ombre-auth.0=a', '__Host-ombre-auth.1=b', '__Host-ombre-auth-code-verifier=c'].join('; ')
  let scope
  const { routes } = buildRoutes({ auth: { signOut: async (o) => { scope = o.scope; throw new Error('network') } } })
  const res = await routes.signout(makeRequest('/api/auth/signout', { cookie }))
  assert.equal(res.status, 200)
  assert.equal(scope, 'local')
  const set = res.headers.getSetCookie()
  assert.equal(set.length, 3)
  assert.ok(set.every((c) => c.includes('Max-Age=0') && c.includes('Secure') && c.includes('HttpOnly') && c.includes('Path=/') && !/domain/i.test(c)))
  assert.equal((await routes.signout(makeRequest('/api/auth/signout', { csrf: false }))).status, 403)
  assert.equal((await routes.signout(makeRequest('/api/auth/signout', { origin: 'https://evil.example' }))).status, 403)
})

test('every state-changing route rejects a cross-origin request before touching the provider', async () => {
  let touched = 0
  const auth = new Proxy({}, { get: () => async () => { touched++; return { data: {}, error: null } } })
  const { routes } = buildRoutes({ auth, config: prodConfig() })
  const body = { email: 'a@example.com', password: PW, code: '2f1c9a5e-0b7d-4c1e-9f3a-123456789abc' }
  const cases = [
    [routes.signin, { email: body.email, password: body.password }],
    [routes.signup, { email: body.email, password: body.password }],
    [routes.forgotPassword, { email: body.email }],
    [routes.callback, { code: body.code }],
    [routes.resetPassword, { password: body.password }],
    [routes.signout, undefined],
  ]
  for (const [route, b] of cases) {
    assert.equal((await route(makeRequest('/api/auth/x', { body: b, origin: 'https://evil.example' }))).status, 403)
    assert.equal((await route(makeRequest('/api/auth/x', { body: b, csrf: false }))).status, 403)
  }
  assert.equal(touched, 0)
})
