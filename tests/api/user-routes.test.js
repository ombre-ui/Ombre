import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRequest, json, ORIGIN } from './helpers.js'
import { buildUserRoutes } from './user-helpers.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'
const EMAIL = 'ada@example.com'

const SETTINGS_ROW = {
  theme: 'system',
  notifications_email: true,
  notifications_in_app: true,
  save_history: true,
  remember_context: false,
  response_style: 'balanced',
  use_name_in_responses: false,
  suggest_mentors: true,
}
const PROFILE_ROW = { display_name: 'Ada', created_at: '2026-10-01T00:00:00+00:00' }

const authOk = { getUser: async () => ({ data: { user: { id: USER_ID, email: EMAIL } }, error: null }) }

// Recording fake of the supabase-js query builder: from(table).update(v).eq(c, x).select(cols) / .select(cols).eq(c, x)
function recordingFrom(respond) {
  const calls = []
  const from = (table) => {
    const call = { table, op: 'select', values: undefined, filters: [], columns: undefined }
    calls.push(call)
    const builder = {
      select(columns) { call.columns = columns; return builder },
      update(values) { call.op = 'update'; call.values = values; return builder },
      eq(column, value) { call.filters.push([column, value]); return builder },
      then(resolve, reject) { return Promise.resolve(respond(call)).then(resolve, reject) },
    }
    return builder
  }
  from.calls = calls
  return from
}

const rowsFor = (call) => (call.table === 'profiles' ? [PROFILE_ROW] : [SETTINGS_ROW])
const okRespond = (call) => ({ data: rowsFor(call), error: null, status: 200 })

function setup(opts = {}) {
  const from = recordingFrom(opts.respond || okRespond)
  const built = buildUserRoutes({ auth: opts.auth || authOk, from, emitCookies: opts.emitCookies })
  return { ...built, from }
}

const get = (path) => makeRequest(path, { method: 'GET', csrf: false, origin: undefined })
const patch = (path, body, extra = {}) => makeRequest(path, { method: 'PATCH', body, ...extra })

// ---------- profile ----------

test('GET /api/user/profile: no content-type needed, explicit columns, owner filter from the session', async () => {
  const { routes, from } = setup()
  const res = await routes.profile(get('/api/user/profile'))
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { profile: { displayName: 'Ada', email: EMAIL, createdAt: PROFILE_ROW.created_at } })
  assert.match(res.headers.get('cache-control'), /no-store/)
  assert.equal(from.calls.length, 1)
  assert.deepEqual(from.calls[0], { table: 'profiles', op: 'select', values: undefined, filters: [['id', USER_ID]], columns: 'display_name,created_at' })
})

test('GET profile: a client-supplied id (query string or header) is ignored; only the session user is queried', async () => {
  const { routes, from } = setup()
  const req = new Request(`http://internal.invalid/api/user/profile?id=${OTHER_ID}&user_id=${OTHER_ID}`, { method: 'GET', headers: { 'x-user-id': OTHER_ID } })
  const res = await routes.profile(req)
  assert.equal(res.status, 200)
  assert.deepEqual(from.calls[0].filters, [['id', USER_ID]])
})

test('GET profile with a null display name reads as null (nothing invented)', async () => {
  const { routes } = setup({ respond: () => ({ data: [{ display_name: null, created_at: PROFILE_ROW.created_at }], error: null, status: 200 }) })
  const body = await json(await routes.profile(get('/api/user/profile')))
  assert.equal(body.profile.displayName, null)
})

test('PATCH /api/user/profile writes exactly one allowlisted column', async () => {
  const { routes, from } = setup()
  const res = await routes.profile(patch('/api/user/profile', { displayName: '  Ada Lovelace  ' }))
  assert.equal(res.status, 200)
  assert.deepEqual(from.calls[0], { table: 'profiles', op: 'update', values: { display_name: 'Ada Lovelace' }, filters: [['id', USER_ID]], columns: 'display_name,created_at' })
  assert.equal((await json(res)).profile.email, EMAIL)
})

test('PATCH profile: empty or whitespace name clears to null; null clears', async () => {
  for (const displayName of ['', '   ', null]) {
    const { routes, from } = setup()
    assert.equal((await routes.profile(patch('/api/user/profile', { displayName }))).status, 200)
    assert.deepEqual(from.calls[0].values, { display_name: null })
  }
})

test('PATCH profile: invalid input is rejected before the database is touched', async () => {
  const bad = [
    {},
    { displayName: 5 },
    { displayName: ['a'] },
    { displayName: 'x'.repeat(101) },
    { displayName: 'two\nlines' },
    { displayName: 'tab\there' },
    { displayName: 'nul\u0000' },
    { displayName: 'ok', id: OTHER_ID },
    { displayName: 'ok', email: 'x@y.co' },
    { displayName: 'ok', created_at: 'now' },
    { id: OTHER_ID },
  ]
  for (const body of bad) {
    const { routes, from } = setup()
    const res = await routes.profile(patch('/api/user/profile', body))
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal((await json(res)).error.code, 'invalid_request')
    assert.equal(from.calls.length, 0, JSON.stringify(body))
  }
})

test('PATCH profile: 100 characters is allowed (counted in characters, not UTF-16 units)', async () => {
  const { routes, from } = setup()
  const name = '😀'.repeat(100) // 200 UTF-16 units, 100 characters
  assert.equal((await routes.profile(patch('/api/user/profile', { displayName: name }))).status, 200)
  assert.equal(from.calls[0].values.display_name, name)
  const { routes: r2 } = setup()
  assert.equal((await r2.profile(patch('/api/user/profile', { displayName: '😀'.repeat(101) }))).status, 400)
})

// ---------- settings ----------

test('GET /api/user/settings maps flat columns to the nested wire shape', async () => {
  const { routes, from } = setup()
  const res = await routes.settings(get('/api/user/settings'))
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), {
    settings: {
      general: { theme: 'system' },
      notifications: { email: true, inApp: true },
      privacy: { saveHistory: true, rememberContext: false },
      ai: { responseStyle: 'balanced', useNameInResponses: false, suggestMentors: true },
    },
  })
  assert.equal(from.calls[0].table, 'user_settings')
  assert.deepEqual(from.calls[0].filters, [['user_id', USER_ID]])
  assert.equal(from.calls[0].columns, 'theme,notifications_email,notifications_in_app,save_history,remember_context,response_style,use_name_in_responses,suggest_mentors')
})

test('PATCH settings maps nested partials to flat columns and nothing else', async () => {
  const { routes, from } = setup()
  const res = await routes.settings(
    patch('/api/user/settings', {
      general: { theme: 'dark' },
      notifications: { inApp: false },
      privacy: { rememberContext: true },
      ai: { responseStyle: 'concise', suggestMentors: false },
    })
  )
  assert.equal(res.status, 200)
  assert.equal(from.calls[0].op, 'update')
  assert.deepEqual(from.calls[0].values, {
    theme: 'dark',
    notifications_in_app: false,
    remember_context: true,
    response_style: 'concise',
    suggest_mentors: false,
  })
  assert.deepEqual(from.calls[0].filters, [['user_id', USER_ID]])
})

test('PATCH settings: every invalid shape is a 400 and never reaches the database', async () => {
  const bad = [
    {},
    { ai: {} },
    { admin: { x: 1 } },
    { user_id: OTHER_ID },
    { created_at: 'x' },
    { general: { theme: 'blue' } },
    { general: { theme: 5 } },
    { general: { accent: 'red' } },
    { notifications: { email: 'yes' } },
    { notifications: { email: 1 } },
    { notifications: { email: null } },
    { privacy: [] },
    { privacy: null },
    { privacy: 'all' },
    { ai: { responseStyle: 'verbose' } },
    { ai: { useNameInResponses: 'true' } },
    { ai: { foo: true } },
    { ai: { suggestMentors: true, updated_at: 'now' } },
    { notifications: { email: true }, billing: { plan: 'x' } },
    JSON.parse('{"__proto__": {"theme": "dark"}}'),
    JSON.parse('{"ai": {"__proto__": true}}'),
    JSON.parse('{"ai": {"constructor": true}}'),
  ]
  for (const body of bad) {
    const { routes, from } = setup()
    const res = await routes.settings(patch('/api/user/settings', body))
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(from.calls.length, 0, JSON.stringify(body))
  }
})

test('PATCH settings: theme accepts system, light and dark', async () => {
  for (const theme of ['system', 'light', 'dark']) {
    const { routes, from } = setup()
    assert.equal((await routes.settings(patch('/api/user/settings', { general: { theme } }))).status, 200)
    assert.deepEqual(from.calls[0].values, { theme })
  }
})

// ---------- authentication ----------

test('401 when there is no session; the database is never queried', async () => {
  const auth = { getUser: async () => ({ data: { user: null }, error: Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400 }) }) }
  for (const [name, request] of [
    ['profile', get('/api/user/profile')],
    ['settings', get('/api/user/settings')],
    ['profile', patch('/api/user/profile', { displayName: 'x' })],
    ['settings', patch('/api/user/settings', { ai: { suggestMentors: true } })],
  ]) {
    const { routes, from } = setup({ auth })
    const res = await routes[name](request)
    assert.equal(res.status, 401)
    assert.equal((await json(res)).error.code, 'unauthenticated')
    assert.equal(from.calls.length, 0)
  }
})

test('401 when getUser returns no user without an error', async () => {
  const { routes, from } = setup({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } })
  assert.equal((await routes.profile(get('/api/user/profile'))).status, 401)
  assert.equal(from.calls.length, 0)
})

test('an auth-server outage is 503, never 401 (it must not look like being signed out)', async () => {
  const auth = { getUser: async () => ({ data: { user: null }, error: Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError', status: 0 }) }) }
  const { routes, from } = setup({ auth })
  const res = await routes.settings(get('/api/user/settings'))
  assert.equal(res.status, 503)
  assert.equal((await json(res)).error.code, 'service_unavailable')
  assert.equal(from.calls.length, 0)
})

test('authorization uses getUser(), never getSession()', async () => {
  let sessionCalled = false
  const auth = { ...authOk, getSession: async () => { sessionCalled = true; return { data: { session: null } } } }
  const { routes } = setup({ auth })
  await routes.profile(get('/api/user/profile'))
  assert.equal(sessionCalled, false)
})

// ---------- zero rows, outages, generic errors ----------

test('zero rows is an explicit 404 for GET and PATCH on both resources (no insert, no upsert)', async () => {
  const respond = () => ({ data: [], error: null, status: 200 })
  for (const [name, request] of [
    ['profile', get('/api/user/profile')],
    ['settings', get('/api/user/settings')],
    ['profile', patch('/api/user/profile', { displayName: 'x' })],
    ['settings', patch('/api/user/settings', { ai: { suggestMentors: false } })],
  ]) {
    const { routes, from, lines } = setup({ respond })
    const res = await routes[name](request)
    assert.equal(res.status, 404)
    assert.equal((await json(res)).error.code, 'not_found')
    assert.ok(from.calls.every((c) => c.op === 'select' || c.op === 'update'))
    assert.ok(lines.some((l) => l.includes('row_missing')))
  }
})

test('more than one row is a generic 500', async () => {
  const { routes } = setup({ respond: () => ({ data: [PROFILE_ROW, PROFILE_ROW], error: null, status: 200 }) })
  const res = await routes.profile(get('/api/user/profile'))
  assert.equal(res.status, 500)
  assert.equal((await json(res)).error.code, 'internal_error')
})

test('database outages (network or 5xx) are 503 and leak nothing', async () => {
  for (const status of [0, 500, 502, 503]) {
    const respond = () => ({ data: null, error: { name: 'PostgrestError', message: 'secret-detail user@example.com', code: 'XX000', details: 'row 1', hint: '' }, status })
    const { routes, lines } = setup({ respond })
    const res = await routes.profile(get('/api/user/profile'))
    const text = await res.text()
    assert.equal(res.status, 503, String(status))
    assert.equal(JSON.parse(text).error.code, 'service_unavailable')
    assert.ok(!/secret-detail|user@example|row 1/.test(text))
    assert.ok(lines.every((l) => !/secret-detail|user@example|row 1/.test(l)))
  }
})

test('permission, constraint and other database errors are a generic 500 with no details', async () => {
  for (const [status, code] of [[403, '42501'], [400, '23514'], [409, '23505'], [404, 'PGRST205']]) {
    const respond = () => ({ data: null, error: { name: 'PostgrestError', message: 'secret-detail display_name_check', code }, status })
    const { routes, lines } = setup({ respond })
    const res = await routes.profile(patch('/api/user/profile', { displayName: 'x' }))
    const text = await res.text()
    assert.equal(res.status, 500, `${status} ${code}`)
    assert.equal(JSON.parse(text).error.code, 'internal_error')
    assert.ok(!/secret-detail|display_name_check|42501|23514/.test(text))
    assert.ok(lines.every((l) => !/secret-detail|display_name_check/.test(l)))
    assert.ok(lines.some((l) => l.includes(code)), 'the SQLSTATE/PGRST code is logged for operators')
  }
})

test('an invalid-JWT answer from the data API is a 401', async () => {
  const respond = () => ({ data: null, error: { name: 'PostgrestError', message: 'JWT expired', code: 'PGRST301' }, status: 401 })
  const { routes } = setup({ respond })
  const res = await routes.settings(get('/api/user/settings'))
  assert.equal(res.status, 401)
  assert.equal((await json(res)).error.code, 'unauthenticated')
})

test('a thrown query error is a generic 500', async () => {
  const { routes, lines } = setup({ respond: () => { throw new Error('boom secret=hunter2') } })
  const res = await routes.profile(get('/api/user/profile'))
  const text = await res.text()
  assert.equal(res.status, 500)
  assert.ok(!/hunter2|boom/.test(text))
  assert.ok(lines.every((l) => !/hunter2|boom/.test(l)))
})

// ---------- request protection (shared pipeline) ----------

test('PATCH needs an exact Origin and the custom header; the session is not even consulted otherwise', async () => {
  let authCalls = 0
  const auth = { getUser: async () => { authCalls += 1; return authOk.getUser() } }
  const { routes, from } = setup({ auth })
  assert.equal((await routes.profile(patch('/api/user/profile', { displayName: 'x' }, { origin: 'https://evil.example' }))).status, 403)
  assert.equal((await routes.profile(patch('/api/user/profile', { displayName: 'x' }, { origin: undefined }))).status, 403)
  assert.equal((await routes.profile(patch('/api/user/profile', { displayName: 'x' }, { csrf: false }))).status, 403)
  assert.equal((await routes.settings(patch('/api/user/settings', { ai: { suggestMentors: true } }, { origin: ORIGIN + '.evil.example' }))).status, 403)
  assert.equal(authCalls, 0)
  assert.equal(from.calls.length, 0)
})

test('cross-site requests are rejected for GET as well', async () => {
  const { routes } = setup()
  const req = new Request('http://internal.invalid/api/user/profile', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal((await routes.profile(req)).status, 403)
})

test('PATCH must be JSON (415), is size-limited (413), and rejects arrays and bad JSON (400)', async () => {
  const { routes } = setup()
  const textReq = new Request('http://internal.invalid/api/user/profile', { method: 'PATCH', headers: { origin: ORIGIN, 'x-ombre-request': '1', 'content-type': 'text/plain' }, body: 'displayName=x' })
  assert.equal((await routes.profile(textReq)).status, 415)
  assert.equal((await routes.profile(patch('/api/user/profile', { displayName: 'x'.repeat(5000) }))).status, 413)
  for (const body of ['{bad', '[1]', 'null', '"x"']) {
    assert.equal((await routes.settings(patch('/api/user/settings', body))).status, 400, body)
  }
})

test('405 for other methods, with Allow: GET, PATCH', async () => {
  const { routes } = setup()
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await routes.profile(makeRequest('/api/user/profile', { method, body: { displayName: 'x' } }))
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.get('allow'), 'GET, PATCH')
  }
})

test('responses are no-store with nosniff and a request id, on success and on errors', async () => {
  const { routes } = setup()
  for (const res of [await routes.settings(get('/api/user/settings')), await routes.settings(patch('/api/user/settings', {}))]) {
    assert.match(res.headers.get('cache-control'), /private, no-store/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/)
  }
})

// ---------- cookie propagation on data routes ----------

test('Set-Cookie from a session refresh reaches the client on GET, PATCH, 404 and 401 responses', async () => {
  const emitCookies = (jar, cfg) => jar.setAll([{ name: cfg.cookieName, value: 'rotated-session', options: { maxAge: 3600 } }])
  const cases = [
    [setup({ emitCookies }), 'profile', get('/api/user/profile'), 200],
    [setup({ emitCookies }), 'settings', patch('/api/user/settings', { ai: { suggestMentors: true } }), 200],
    [setup({ emitCookies, respond: () => ({ data: [], error: null, status: 200 }) }), 'profile', get('/api/user/profile'), 404],
    [setup({ emitCookies, auth: { getUser: async () => ({ data: { user: null }, error: Object.assign(new Error('x'), { name: 'AuthSessionMissingError', status: 400 }) }) } }), 'profile', get('/api/user/profile'), 401],
  ]
  for (const [{ routes }, name, request, status] of cases) {
    const res = await routes[name](request)
    assert.equal(res.status, status)
    const cookies = res.headers.getSetCookie()
    assert.equal(cookies.length, 1, `status ${status}`)
    assert.match(cookies[0], /^__Host-ombre-auth=rotated-session; Max-Age=3600; Path=\/; HttpOnly; SameSite=Lax; Secure$/)
    assert.match(res.headers.get('cache-control'), /no-store/)
  }
})

test('requests with no session activity set no cookies', async () => {
  const { routes } = setup()
  assert.deepEqual((await routes.profile(get('/api/user/profile'))).headers.getSetCookie(), [])
})
