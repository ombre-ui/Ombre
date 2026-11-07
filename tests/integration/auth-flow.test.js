// End-to-end auth flow against a REAL local Supabase stack (`supabase start`), driving the real routes
// (real @supabase/ssr, real cookies) as Web Request/Response, with a tiny cookie-jar "browser".
// Skipped unless AUTH_INTEGRATION=1. Required env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY.
// Emails are read from the local mail catcher (Mailpit) at MAIL_API (default http://127.0.0.1:54324).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto' // TEMP DIAG (remove with the rest of the PKCE diagnostic)

const RUN = process.env.AUTH_INTEGRATION === '1'
const ORIGIN = 'http://localhost:3000'
const MAIL_API = process.env.MAIL_API || 'http://127.0.0.1:54324'
const PASSWORD = 'integration-test-password-1'
const NEW_PASSWORD = 'integration-test-password-2'

const suite = RUN ? test : test.skip

if (RUN) {
  assert.ok(process.env.SUPABASE_URL, 'SUPABASE_URL is required for AUTH_INTEGRATION=1')
  assert.ok(process.env.SUPABASE_PUBLISHABLE_KEY, 'SUPABASE_PUBLISHABLE_KEY is required for AUTH_INTEGRATION=1')
}

// TEMP DIAG: hashes only, never the verifier itself
const sha = (s) => createHash('sha256').update(s).digest('base64url')
function describeCookie(name, raw) {
  try {
    const json = raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64url').toString('utf8') : raw
    const v = JSON.parse(json)
    if (typeof v === 'string') {
      const [verifier, suffix] = v.split('/')
      return { name, kind: 'verifier', verifierSha: sha(verifier), suffix: suffix ?? null }
    }
    if (Array.isArray(v)) return { name, kind: 'index', flowIds: v }
  } catch {}
  return { name, kind: 'other', rawLen: raw.length }
}

function browser(routes) {
  const jar = new Map()
  const cookieHeader = () => Array.from(jar, ([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  async function call(name, { method = 'POST', path, body } = {}) {
    const headers = new Headers({ origin: ORIGIN, 'x-ombre-request': '1' })
    if (jar.size) headers.set('cookie', cookieHeader())
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await routes[name](new Request(`http://internal.invalid${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }))
    const setCookies = res.headers.getSetCookie()
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim())
      const idx = pair.indexOf('=')
      const cname = pair.slice(0, idx)
      const cval = decodeURIComponent(pair.slice(idx + 1))
      if (attrs.includes('Max-Age=0')) jar.delete(cname)
      else jar.set(cname, cval)
    }
    return { status: res.status, body: await res.json(), setCookies }
  }
  return { jar, call }
}

async function latestMailLink(address, pattern) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const list = await (await fetch(`${MAIL_API}/api/v1/messages?limit=50`)).json()
    const msg = (list.messages || []).find((m) => (m.To || []).some((t) => t.Address === address) && pattern.test(m.Subject || ''))
    if (msg) {
      const full = await (await fetch(`${MAIL_API}/api/v1/message/${msg.ID}`)).json()
      const link = (full.Text || '').match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/)
      if (link) return link[0]
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no email for ${address}`)
}

// Follow Supabase's verify link without following the redirect to the app; return the ?code= it redirects with.
async function codeFromLink(link) {
  const res = await fetch(link, { redirect: 'manual' })
  const location = res.headers.get('location')
  assert.ok(location, `verify link did not redirect (status ${res.status})`)
  const url = new URL(location)
  assert.equal(url.origin, ORIGIN)
  const code = url.searchParams.get('code')
  assert.ok(code, 'redirect carried no PKCE code')
  return { code, path: url.pathname }
}

suite('auth flow: signup -> PKCE confirm -> session -> signout -> signin -> recovery -> reset', async () => {
  process.env.APP_ORIGINS = ORIGIN
  process.env.AUTH_ALLOW_INSECURE_COOKIES = 'true'
  const { routes } = await import('../../api/_lib/real.js')
  const email = `a2-${Date.now()}@example.com`
  const b = browser(routes)

  // signup: generic response, PKCE verifier cookie issued (HttpOnly, SameSite=Lax, <= 1h)
  const signup = await b.call('signup', { path: '/api/auth/signup', body: { email, password: PASSWORD } })
  assert.equal(signup.status, 200)
  assert.deepEqual(signup.body, { ok: true, status: 'check_email' })
  assert.ok(signup.setCookies.length > 0, 'expected a PKCE verifier cookie')
  for (const sc of signup.setCookies) {
    assert.match(sc, /HttpOnly/)
    assert.match(sc, /SameSite=Lax/)
    assert.doesNotMatch(sc, /Domain=/i)
    assert.ok(Number(/Max-Age=(\d+)/.exec(sc)[1]) <= 3600)
  }

  // not signed in until confirmed
  assert.deepEqual((await b.call('session', { method: 'GET', path: '/api/auth/session' })).body, { user: null })
  const early = await b.call('signin', { path: '/api/auth/signin', body: { email, password: PASSWORD } })
  assert.equal(early.status, 403)
  assert.equal(early.body.error.code, 'email_not_confirmed')

  // confirm via the emailed PKCE link, in the same "browser"
  const { code } = await codeFromLink(await latestMailLink(email, /confirm/i))
  const confirmed = await b.call('callback', { path: '/api/auth/callback', body: { code } })
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.body.next, '/app/general')
  const sessionCookies = confirmed.setCookies.filter((c) => !/code-verifier/.test(c))
  assert.ok(sessionCookies.length > 0)
  for (const sc of sessionCookies) {
    assert.match(sc, /HttpOnly/)
    assert.match(sc, /SameSite=Lax/)
    assert.match(sc, /Path=\//)
    assert.doesNotMatch(sc, /Domain=/i)
    assert.ok(Number(/Max-Age=(\d+)/.exec(sc)[1]) <= 30 * 86400)
  }

  // session restoration (cookie only), only id+email exposed
  const restored = await b.call('session', { method: 'GET', path: '/api/auth/session' })
  assert.equal(restored.body.user.email, email)
  assert.deepEqual(Object.keys(restored.body.user).sort(), ['email', 'id'])

  // the code is single-use
  const replay = await browser(routes).call('callback', { path: '/api/auth/callback', body: { code } })
  assert.equal(replay.status, 400)

  // signout expires every auth cookie and the session is gone
  const out = await b.call('signout', { path: '/api/auth/signout' })
  assert.equal(out.status, 200)
  assert.equal(Array.from(b.jar.keys()).filter((k) => k.startsWith('ombre-auth')).length, 0)
  assert.deepEqual((await b.call('session', { method: 'GET', path: '/api/auth/session' })).body, { user: null })

  // signin: wrong password is generic, right password works
  const bad = await b.call('signin', { path: '/api/auth/signin', body: { email, password: 'wrong-password-123' } })
  assert.equal(bad.status, 401)
  assert.equal(bad.body.error.code, 'invalid_credentials')
  const ok = await b.call('signin', { path: '/api/auth/signin', body: { email, password: PASSWORD } })
  assert.equal(ok.status, 200)
  assert.equal((await b.call('session', { method: 'GET', path: '/api/auth/session' })).body.user.email, email)

  // reset requires a session; short passwords are refused before the provider
  assert.equal((await browser(routes).call('resetPassword', { path: '/api/auth/reset-password', body: { password: NEW_PASSWORD } })).status, 401)
  assert.equal((await b.call('resetPassword', { path: '/api/auth/reset-password', body: { password: 'short' } })).status, 400)

  // TEMP DIAG: spy on PKCE values sent to local Supabase Auth; fetch is restored in `finally`.
  const realFetch = globalThis.fetch
  const diag = { recover: [], token: [] }
  globalThis.fetch = async (input, init) => {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input)
      if (typeof init?.body === 'string' && (url.includes('/auth/v1/recover') || url.includes('grant_type=pkce'))) {
        const body = JSON.parse(init.body)
        if (url.includes('/auth/v1/recover')) {
          diag.recover.push({ email: body.email, challenge: body.code_challenge, method: body.code_challenge_method, verifierSha: body.code_verifier ? sha(body.code_verifier) : null })
        } else {
          diag.token.push({ authCode8: String(body.auth_code).slice(0, 8), verifierSha: body.code_verifier ? sha(body.code_verifier) : null })
        }
      }
    } catch { /* diagnostics must never break a request */ }
    return realFetch(input, init)
  }
  try {
    // recovery (PKCE) in a fresh browser: forgot -> link -> callback(recovery) -> reset -> signin with new password
    const r = browser(routes)
    const forgot = await r.call('forgotPassword', { path: '/api/auth/forgot-password', body: { email } })
    assert.deepEqual(forgot.body, { ok: true })

    const neutral = browser(routes)
    assert.deepEqual(
      (await neutral.call('forgotPassword', {
        path: '/api/auth/forgot-password',
        body: { email: `nobody-${Date.now()}@example.com` },
      })).body,
      { ok: true },
    )
    const link = await latestMailLink(email, /reset|recover/i)
    const rec = await codeFromLink(link)
    assert.equal(rec.path, '/auth/callback/recovery')

    const jarBefore = Array.from(r.jar, ([k, v]) => describeCookie(k, v))
    const exchanged = await r.call('callback', { path: '/api/auth/callback', body: { code: rec.code, purpose: 'recovery' } })

    // TEMP DIAG output (hashes only)
    const mine = diag.recover.filter((x) => x.email === email)
    const fixed = jarBefore.find((c) => c.kind === 'verifier' && !c.name.includes('-flow-'))
    const slots = jarBefore.filter((c) => c.kind === 'verifier' && c.name.includes('-flow-'))
    const linkUrl = new URL(link)
    console.log('PKCE_DIAG', JSON.stringify({
      email,
      recoverCallsForEmail: mine.length,
      recoverAll: diag.recover,
      tokenCalls: diag.token,
      tokenShaMatchesRecoverChallenge: diag.token.map((t) => mine.some((m) => m.challenge === t.verifierSha)),
      fixedCookieShaMatchesChallenge: fixed ? mine.some((m) => m.challenge === fixed.verifierSha) : null,
      slotCookieShaMatchesChallenge: slots.map((s) => ({ name: s.name, match: mine.some((m) => m.challenge === s.verifierSha) })),
      forgotSetCookies: forgot.setCookies.map((sc) => {
        const [p] = sc.split(';')
        const i = p.indexOf('=')
        return describeCookie(p.slice(0, i), decodeURIComponent(p.slice(i + 1)))
      }),
      jarBeforeCallback: jarBefore,
      linkType: linkUrl.searchParams.get('type'),
      linkToken12: (linkUrl.searchParams.get('token') || '').slice(0, 12),
      code8: rec.code.slice(0, 8),
      callbackStatus: exchanged.status,
      callbackError: exchanged.body && exchanged.body.error ? exchanged.body.error.code : null,
    }, null, 2))

    console.log('RECOVERY_CALLBACK_DIAGNOSTIC', JSON.stringify(exchanged))
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged))
    assert.equal(exchanged.body.next, '/reset-password')
    assert.equal((await r.call('resetPassword', { path: '/api/auth/reset-password', body: { password: NEW_PASSWORD } })).status, 200)
    assert.equal((await browser(routes).call('signin', { path: '/api/auth/signin', body: { email, password: NEW_PASSWORD } })).status, 200)
    assert.equal((await browser(routes).call('signin', { path: '/api/auth/signin', body: { email, password: PASSWORD } })).status, 401)
  } finally {
    globalThis.fetch = realFetch
  }
})

suite('PKCE link opened in a different browser fails with the wrong-browser error', async () => {
  process.env.APP_ORIGINS = ORIGIN
  process.env.AUTH_ALLOW_INSECURE_COOKIES = 'true'
  const { routes } = await import('../../api/_lib/real.js')
  const email = `a2-xb-${Date.now()}@example.com`
  const b = browser(routes)
  const signup = await b.call('signup', {
    path: '/api/auth/signup',
    body: { email, password: PASSWORD }
  })
  assert.equal(signup.status, 200)
  assert.deepEqual(signup.body, { ok: true, status: 'check_email' })
  const { code } = await codeFromLink(await latestMailLink(email, /confirm/i))
  const other = await browser(routes).call('callback', { path: '/api/auth/callback', body: { code } })
  assert.equal(other.status, 400)
  assert.equal(other.body.error.code, 'link_wrong_browser')
})
