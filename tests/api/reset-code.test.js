import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoutes } from '../../api/_lib/routes.js'
import { createMemoryLimiter } from '../../api/_lib/limiter.js'
import { prodConfig, memoryLogger, makeRequest, json, fakeSupabaseFactory } from './helpers.js'

const EMAIL = 'ada@example.com'
const CODE = '1234567'
const emailUser = { id: 'u1', email: EMAIL, app_metadata: { provider: 'email', providers: ['email'] }, identities: [{ provider: 'email' }] }

function setup({ auth = {}, emitCookies } = {}) {
  const clock = { t: 1_000_000 }
  const limiter = createMemoryLimiter({ now: () => clock.t })
  const { lines, logger } = memoryLogger()
  const config = prodConfig()
  const createSupabase = fakeSupabaseFactory(auth, { config, emitCookies })
  const routes = createRoutes({ getConfig: () => config, createSupabase, logger, limiter })
  return { routes, clock, lines, limiter }
}

const post = (body, extra = {}) => makeRequest('/api/auth/reset-code', { body, ...extra })
const request = (email = EMAIL, extra = {}) => post({ action: 'request', email }, extra)
const verify = (code = CODE, email = EMAIL, extra = {}) => post({ action: 'verify', email, code }, extra)
const MIN = 60 * 1000

function sender(calls = [], result = { data: {}, error: null }) {
  return { resetPasswordForEmail: async (...args) => { calls.push(args); return result } }
}
function verifier(calls = [], result) {
  return {
    verifyOtp: async (args) => { calls.push(args); return typeof result === 'function' ? result(args) : result },
    signOut: async () => ({ error: null }),
  }
}
const goodVerify = { data: { user: emailUser, session: { access_token: 'x' } }, error: null }
const badVerify = { data: { user: null, session: null }, error: { name: 'AuthApiError', status: 403, code: 'otp_expired', message: 'Token has expired or is invalid secret-detail' } }

// ---------- request: neutral, enumeration-safe ----------

test('request asks Supabase to email a code: normalised email only, no redirect, no link parameters', async () => {
  const calls = []
  const { routes } = setup({ auth: sender(calls) })
  const res = await routes.resetCode(request('  Ada@Example.COM '))
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { ok: true })
  assert.deepEqual(calls, [[EMAIL]])
})

test('account-enumeration safety: success, "no such user", provider errors and throttled requests all look identical', async () => {
  const outcomes = [
    sender([], { data: {}, error: null }),
    sender([], { data: {}, error: { name: 'AuthApiError', status: 400, code: 'user_not_found', message: 'secret' } }),
    sender([], { data: {}, error: { name: 'AuthApiError', status: 429, code: 'over_email_send_rate_limit', message: 'secret' } }),
    sender([], { data: {}, error: { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'Error sending recovery email secret' } }),
  ]
  const bodies = []
  for (const auth of outcomes) {
    const { routes } = setup({ auth })
    const res = await routes.resetCode(request())
    assert.equal(res.status, 200)
    bodies.push(await res.text())
  }
  const { routes } = setup({ auth: sender() })
  await routes.resetCode(request())
  const throttled = await routes.resetCode(request()) // inside the 60 s cooldown
  assert.equal(throttled.status, 200)
  bodies.push(await throttled.text())
  assert.equal(new Set(bodies).size, 1, 'every outcome yields the same bytes')
  assert.equal(bodies[0], '{"ok":true}')
})

test('only a connectivity failure is surfaced (503); it does not depend on whether an account exists', async () => {
  const { routes } = setup({ auth: sender([], { data: {}, error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed secret' } }) })
  const res = await routes.resetCode(request())
  assert.equal(res.status, 503)
  assert.ok(!(await res.text()).includes('secret'))
})

// ---------- request: cooldown and rate limiting ----------

test('cooldown: a repeat within 60 s sends nothing new (neutral 200); after 60 s it sends again', async () => {
  const calls = []
  const { routes, clock } = setup({ auth: sender(calls) })
  await routes.resetCode(request())
  clock.t += 30 * 1000
  assert.equal((await routes.resetCode(request())).status, 200)
  assert.equal(calls.length, 1)
  clock.t += 31 * 1000
  assert.equal((await routes.resetCode(request())).status, 200)
  assert.equal(calls.length, 2)
})

test('hourly cap per email: at most five sends per hour, the rest silently dropped', async () => {
  const calls = []
  const { routes, clock } = setup({ auth: sender(calls) })
  for (let i = 0; i < 8; i += 1) {
    await routes.resetCode(request())
    clock.t += 61 * 1000
  }
  assert.equal(calls.length, 5)
  clock.t += 60 * MIN // window passes
  await routes.resetCode(request())
  assert.equal(calls.length, 6)
})

test('per-IP request cap: the eleventh request in an hour from one IP is a 429, whatever the email', async () => {
  const calls = []
  const { routes } = setup({ auth: sender(calls) })
  let last
  for (let i = 0; i < 11; i += 1) last = await routes.resetCode(request(`user${i}@example.com`, { headers: { 'x-vercel-forwarded-for': '203.0.113.9' } }))
  assert.equal(last.status, 429)
  assert.equal((await json(last)).error.code, 'rate_limited')
  assert.equal(calls.length, 10)
  const other = await routes.resetCode(request('someone@example.com', { headers: { 'x-vercel-forwarded-for': '203.0.113.10' } }))
  assert.equal(other.status, 200) // another IP is unaffected
})

// ---------- verify ----------

test('verify success: Supabase verifyOtp (recovery), HttpOnly session cookie, next=/reset-password, code in no body/log', async () => {
  const calls = []
  const emitCookies = (jar, cfg) => jar.setAll([{ name: cfg.cookieName, value: 'recovery-session', options: { maxAge: 3600 } }])
  const { routes, lines } = setup({ auth: verifier(calls, goodVerify), emitCookies })
  const res = await routes.resetCode(verify('123 4567'))
  const text = await res.text()
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(text), { ok: true, next: '/reset-password', user: { id: 'u1', email: EMAIL } })
  assert.deepEqual(calls, [{ email: EMAIL, token: CODE, type: 'recovery' }])
  const cookies = res.headers.getSetCookie()
  assert.equal(cookies.length, 1)
  assert.match(cookies[0], /^__Host-ombre-auth=recovery-session; .*HttpOnly.*Secure$/)
  assert.ok(!text.includes(CODE) && !text.includes('recovery-session'))
  assert.ok(lines.every((l) => !l.includes(CODE) && !l.includes(EMAIL)), 'neither the code nor the email is logged')
})

test('code format: exactly 7 digits (spaces/dashes tolerated); anything else is rejected before Supabase is called', async () => {
  for (const code of ['123456', '12345678', '12345a7', '', '       ', 'abcdefg', '1234567\n1', null, undefined, 1234567, ['1234567'], '１２３４５６７']) {
    const calls = []
    const { routes } = setup({ auth: verifier(calls, goodVerify) })
    const res = await routes.resetCode(post({ action: 'verify', email: EMAIL, code }))
    assert.equal(res.status, 400, String(code))
    assert.equal((await json(res)).error.code, 'reset_code_invalid', String(code))
    assert.equal(calls.length, 0, String(code))
  }
  for (const code of ['123-4567', '123 4567', ' 1234567 ']) {
    const calls = []
    const { routes } = setup({ auth: verifier(calls, goodVerify) })
    assert.equal((await routes.resetCode(verify(code))).status, 200, code)
    assert.equal(calls[0].token, CODE)
  }
})

test('wrong, expired and already-used codes are one generic 400 with no detail', async () => {
  for (const error of [
    { name: 'AuthApiError', status: 403, code: 'otp_expired', message: 'Token has expired or is invalid secret-detail' },
    { name: 'AuthApiError', status: 400, code: 'validation_failed', message: 'invalid secret-detail' },
    { name: 'AuthApiError', status: 422, code: 'otp_disabled', message: 'secret-detail' },
  ]) {
    const { routes, lines } = setup({ auth: verifier([], { data: { user: null, session: null }, error }) })
    const res = await routes.resetCode(verify())
    const text = await res.text()
    assert.equal(res.status, 400)
    assert.ok(!/secret-detail|expired|otp/.test(text))
    assert.ok(lines.every((l) => !/secret-detail/.test(l)))
  }
})

test('single use: after one successful verification the same code is refused (Supabase consumes it)', async () => {
  let consumed = false
  const auth = verifier([], () => {
    if (consumed) return badVerify
    consumed = true
    return goodVerify
  })
  const { routes } = setup({ auth })
  assert.equal((await routes.resetCode(verify())).status, 200)
  assert.equal((await routes.resetCode(verify())).status, 400)
})

test('expiry: a code the provider reports as expired is refused, and nothing is cached by this route', async () => {
  let expired = false
  const auth = verifier([], () => (expired ? badVerify : goodVerify))
  const { routes } = setup({ auth })
  assert.equal((await routes.resetCode(verify())).status, 200)
  expired = true
  assert.equal((await routes.resetCode(verify())).status, 400)
})

// ---------- verify: attempt limits ----------

test('attempt limit: five wrong tries lock the email for the window; even the right code is refused without asking Supabase', async () => {
  const calls = []
  let accept = false
  const { routes, clock } = setup({ auth: verifier(calls, () => (accept ? goodVerify : badVerify)) })
  for (let i = 0; i < 5; i += 1) assert.equal((await routes.resetCode(verify(String(1000000 + i)))).status, 400)
  accept = true
  const locked = await routes.resetCode(verify(CODE))
  assert.equal(locked.status, 429)
  assert.equal((await json(locked)).error.code, 'rate_limited')
  assert.equal(calls.length, 5, 'the sixth attempt never reached Supabase')
  clock.t += 61 * MIN
  assert.equal((await routes.resetCode(verify(CODE))).status, 200)
})

test('the attempt limit does not depend on whether the account exists (same 429 for any address)', async () => {
  const { routes } = setup({ auth: verifier([], badVerify) })
  for (const email of ['real@example.com', 'ghost@example.com']) {
    for (let i = 0; i < 5; i += 1) await routes.resetCode(verify('1111111', email))
    assert.equal((await routes.resetCode(verify('1111111', email))).status, 429, email)
  }
})

test('requesting a new code gives a fresh attempt budget; a successful verification clears it', async () => {
  const { routes, clock } = setup({ auth: { ...sender(), ...verifier([], badVerify) } })
  for (let i = 0; i < 5; i += 1) await routes.resetCode(verify('2222222'))
  assert.equal((await routes.resetCode(verify('2222222'))).status, 429)
  clock.t += 61 * 1000
  await routes.resetCode(request()) // new code issued
  assert.equal((await routes.resetCode(verify('2222222'))).status, 400, 'attempts allowed again')

  const ok = setup({ auth: verifier([], goodVerify) })
  for (let i = 0; i < 3; i += 1) await ok.routes.resetCode(verify())
  assert.equal(ok.limiter.size() > 0, true)
})

test('per-IP verification cap: the 21st attempt in 15 minutes from one IP is a 429 across different emails', async () => {
  const { routes } = setup({ auth: verifier([], badVerify) })
  let last
  for (let i = 0; i < 21; i += 1) last = await routes.resetCode(verify('3333333', `user${i}@example.com`, { headers: { 'x-vercel-forwarded-for': '198.51.100.7' } }))
  assert.equal(last.status, 429)
})

// ---------- accounts without an email/password identity ----------

test('Google/GitHub-only accounts get no Ombre password path: generic failure, session destroyed, cookies expired', async () => {
  for (const user of [
    { id: 'g1', email: EMAIL, app_metadata: { provider: 'google', providers: ['google'] }, identities: [{ provider: 'google' }] },
    { id: 'g2', email: EMAIL, app_metadata: { providers: ['github'] } },
    { id: 'g3', email: EMAIL },
  ]) {
    let signedOut = false
    const auth = { verifyOtp: async () => ({ data: { user, session: { access_token: 'x' } }, error: null }), signOut: async () => { signedOut = true; return { error: null } } }
    const emitCookies = (jar, cfg) => jar.setAll([{ name: cfg.cookieName, value: 'tmp-session', options: { maxAge: 3600 } }])
    const { routes } = setup({ auth, emitCookies })
    const res = await routes.resetCode(verify())
    assert.equal(res.status, 400)
    assert.equal(signedOut, true)
    assert.match(res.headers.getSetCookie().join('\n'), /Max-Age=0/)
    assert.ok(!res.headers.getSetCookie().some((c) => c.includes('tmp-session')))
  }
})

test('accounts that have an email/password identity (alone or alongside OAuth) can reset', async () => {
  for (const providers of [['email'], ['email', 'google'], ['github', 'email']]) {
    const user = { id: 'u', email: EMAIL, app_metadata: { providers } }
    const { routes } = setup({ auth: verifier([], { data: { user, session: {} }, error: null }) })
    assert.equal((await routes.resetCode(verify())).status, 200, providers.join())
  }
})

// ---------- request protection ----------

test('CSRF and shape: exact Origin, custom header, POST only, strict body', async () => {
  const calls = []
  const { routes } = setup({ auth: { ...sender(calls), ...verifier(calls, goodVerify) } })
  assert.equal((await routes.resetCode(request(EMAIL, { origin: 'https://evil.example' }))).status, 403)
  assert.equal((await routes.resetCode(request(EMAIL, { csrf: false }))).status, 403)
  assert.equal((await routes.resetCode(makeRequest('/api/auth/reset-code', { method: 'GET', origin: undefined, csrf: false }))).status, 405)
  for (const body of [
    {}, { action: 'nope', email: EMAIL }, { action: 'request' }, { action: 'request', email: 'not-an-email' },
    { action: 'request', email: EMAIL, code: CODE }, { action: 'verify', email: EMAIL },
    { action: 'verify', email: EMAIL, code: CODE, password: 'new-password-123' }, { action: 'request', email: EMAIL, redirectTo: 'https://evil.example' },
  ]) {
    assert.equal((await routes.resetCode(post(body))).status, 400, JSON.stringify(body))
  }
  assert.equal(calls.length, 0)
})

test('responses are no-store and carry no cookie unless a session was established', async () => {
  const { routes } = setup({ auth: sender() })
  const res = await routes.resetCode(request())
  assert.match(res.headers.get('cache-control'), /no-store/)
  assert.deepEqual(res.headers.getSetCookie(), [])
})
