// End-to-end profile/settings against a REAL local Supabase stack (`supabase start`): real routes, real
// @supabase/ssr cookies, real RLS and column grants, two separate users. Skipped unless AUTH_INTEGRATION=1.
// Required env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY. Emails come from Mailpit at MAIL_API.
import test from 'node:test'
import assert from 'node:assert/strict'

const RUN = process.env.AUTH_INTEGRATION === '1'
const ORIGIN = 'http://localhost:3000'
const MAIL_API = process.env.MAIL_API || 'http://127.0.0.1:54324'
const PASSWORD = 'integration-test-password-1'

const suite = RUN ? test : test.skip

if (RUN) {
  assert.ok(process.env.SUPABASE_URL, 'SUPABASE_URL is required for AUTH_INTEGRATION=1')
  assert.ok(process.env.SUPABASE_PUBLISHABLE_KEY, 'SUPABASE_PUBLISHABLE_KEY is required for AUTH_INTEGRATION=1')
}

function browser(routes) {
  const jar = new Map()
  const cookieHeader = () => Array.from(jar, ([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  async function call(name, { method = 'POST', path, body } = {}) {
    const headers = new Headers()
    if (method !== 'GET') {
      headers.set('origin', ORIGIN)
      headers.set('x-ombre-request', '1')
    }
    if (jar.size) headers.set('cookie', cookieHeader())
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await routes[name](new Request(`http://internal.invalid${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }))
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim())
      const idx = pair.indexOf('=')
      const cname = pair.slice(0, idx)
      const cval = decodeURIComponent(pair.slice(idx + 1))
      if (attrs.includes('Max-Age=0')) jar.delete(cname)
      else jar.set(cname, cval)
    }
    return { status: res.status, body: await res.json() }
  }
  return { jar, call, cookieHeader }
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

async function codeFromLink(link) {
  const res = await fetch(link, { redirect: 'manual' })
  const location = res.headers.get('location')
  assert.ok(location, `verify link did not redirect (status ${res.status})`)
  const code = new URL(location).searchParams.get('code')
  assert.ok(code, 'redirect carried no PKCE code')
  return code
}

async function signedInUser(routes, label) {
  const email = `a3-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const b = browser(routes)
  assert.equal((await b.call('signup', { path: '/api/auth/signup', body: { email, password: PASSWORD } })).status, 200)
  const code = await codeFromLink(await latestMailLink(email, /confirm/i))
  assert.equal((await b.call('callback', { path: '/api/auth/callback', body: { code } })).status, 200)
  const me = (await b.call('session', { method: 'GET', path: '/api/auth/session' })).body.user
  assert.equal(me.email, email)
  return { b, email, id: me.id }
}

suite('profile + settings: provisioning, persistence, two-user isolation, allowlists, RLS', async () => {
  process.env.APP_ORIGINS = ORIGIN
  process.env.AUTH_ALLOW_INSECURE_COOKIES = 'true'
  const { routes } = await import('../../api/_lib/real.js')
  const { loadConfig } = await import('../../api/_lib/config.js')
  const { createSupabaseForRequest } = await import('../../api/_lib/supabase.js')

  const A = await signedInUser(routes, 'a')
  const B = await signedInUser(routes, 'b')

  // signed out: 401 on every method, nothing readable
  const anon = browser(routes)
  assert.equal((await anon.call('profile', { method: 'GET', path: '/api/user/profile' })).status, 401)
  assert.equal((await anon.call('settings', { method: 'GET', path: '/api/user/settings' })).status, 401)

  // rows were provisioned by the signup trigger, with database defaults and nothing invented
  const p0 = await A.b.call('profile', { method: 'GET', path: '/api/user/profile' })
  assert.equal(p0.status, 200)
  assert.equal(p0.body.profile.displayName, null)
  assert.equal(p0.body.profile.email, A.email)
  assert.ok(!Number.isNaN(Date.parse(p0.body.profile.createdAt)))
  const s0 = await A.b.call('settings', { method: 'GET', path: '/api/user/settings' })
  assert.equal(s0.status, 200)
  assert.deepEqual(s0.body.settings, {
    general: { theme: 'system' },
    notifications: { email: true, inApp: true },
    privacy: { saveHistory: true, rememberContext: false },
    ai: { responseStyle: 'balanced', useNameInResponses: false, suggestMentors: true },
  })

  // writes persist and round-trip through a brand new "browser" holding the same cookies
  assert.equal((await A.b.call('profile', { method: 'PATCH', path: '/api/user/profile', body: { displayName: '  Ada  ' } })).body.profile.displayName, 'Ada')
  const patched = await A.b.call('settings', { method: 'PATCH', path: '/api/user/settings', body: { general: { theme: 'dark' }, ai: { responseStyle: 'concise' } } })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.settings.general.theme, 'dark')
  assert.equal(patched.body.settings.ai.responseStyle, 'concise')
  assert.equal(patched.body.settings.notifications.email, true) // untouched siblings stay intact
  const second = browser(routes)
  for (const [k, v] of A.b.jar) second.jar.set(k, v)
  assert.equal((await second.call('profile', { method: 'GET', path: '/api/user/profile' })).body.profile.displayName, 'Ada')
  assert.equal((await second.call('settings', { method: 'GET', path: '/api/user/settings' })).body.settings.general.theme, 'dark')

  // clearing the name stores null
  assert.equal((await A.b.call('profile', { method: 'PATCH', path: '/api/user/profile', body: { displayName: '   ' } })).body.profile.displayName, null)
  await A.b.call('profile', { method: 'PATCH', path: '/api/user/profile', body: { displayName: 'Ada' } })

  // user B is untouched by anything A did
  assert.equal((await B.b.call('profile', { method: 'GET', path: '/api/user/profile' })).body.profile.displayName, null)
  const sB = (await B.b.call('settings', { method: 'GET', path: '/api/user/settings' })).body.settings
  assert.equal(sB.general.theme, 'system')
  assert.equal(sB.ai.responseStyle, 'balanced')

  // mass assignment / client-supplied ids are rejected by the API and never reach the database
  for (const body of [{ displayName: 'x', id: B.id }, { id: B.id }, { user_id: B.id }, { displayName: 'x', email: 'evil@example.com' }]) {
    assert.equal((await A.b.call('profile', { method: 'PATCH', path: '/api/user/profile', body })).status, 400)
  }
  for (const body of [{ user_id: B.id }, { general: { theme: 'neon' } }, { ai: { responseStyle: 'verbose' } }, { id: B.id }, {}]) {
    assert.equal((await A.b.call('settings', { method: 'PATCH', path: '/api/user/settings', body })).status, 400)
  }
  assert.equal((await B.b.call('profile', { method: 'GET', path: '/api/user/profile' })).body.profile.displayName, null)

  // RLS and column grants, directly: A's real session against B's rows and against forbidden columns
  const config = loadConfig({ ...process.env })
  const direct = createSupabaseForRequest(new Request('http://internal.invalid/x', { headers: { cookie: A.b.cookieHeader() } }), config).supabase
  const readB = await direct.from('profiles').select('id,display_name').eq('id', B.id)
  assert.equal(readB.error, null)
  assert.deepEqual(readB.data, [], 'A must not be able to read B\'s profile')
  const readBSettings = await direct.from('user_settings').select('theme').eq('user_id', B.id)
  assert.deepEqual(readBSettings.data, [], 'A must not be able to read B\'s settings')
  const writeB = await direct.from('profiles').update({ display_name: 'pwned' }).eq('id', B.id).select('display_name')
  assert.deepEqual(writeB.data, [], 'A must not be able to update B\'s profile (zero rows)')
  const writeBSettings = await direct.from('user_settings').update({ theme: 'dark' }).eq('user_id', B.id).select('theme')
  assert.deepEqual(writeBSettings.data, [])
  const reassign = await direct.from('profiles').update({ id: B.id }).eq('id', A.id).select('id')
  assert.ok(reassign.error, 'id is not a writable column')
  const reown = await direct.from('user_settings').update({ user_id: B.id }).eq('user_id', A.id).select('user_id')
  assert.ok(reown.error, 'user_id is not a writable column')
  const insert = await direct.from('profiles').insert({ id: B.id, display_name: 'x' })
  assert.ok(insert.error, 'authenticated has no INSERT grant')
  const del = await direct.from('profiles').delete().eq('id', A.id).select('id')
  assert.ok(del.error || (del.data || []).length === 0, 'authenticated has no DELETE grant')
  assert.equal((await B.b.call('profile', { method: 'GET', path: '/api/user/profile' })).body.profile.displayName, null)
  assert.equal((await A.b.call('profile', { method: 'GET', path: '/api/user/profile' })).body.profile.displayName, 'Ada')

  // after sign-out the same cookies no longer read or write anything
  const stale = browser(routes)
  for (const [k, v] of A.b.jar) stale.jar.set(k, v)
  assert.equal((await A.b.call('signout', { path: '/api/auth/signout' })).status, 200)
  assert.equal((await A.b.call('profile', { method: 'GET', path: '/api/user/profile' })).status, 401)
})
