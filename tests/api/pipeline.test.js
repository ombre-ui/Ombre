import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoute, MAX_BODY_BYTES } from '../../api/_lib/pipeline.js'
import { ApiError } from '../../api/_lib/errors.js'
import { createLogger, sanitizeFields, scrub } from '../../api/_lib/logger.js'
import { prodConfig, makeRequest, memoryLogger, json } from './helpers.js'

function mk(fn, options = { methods: ['POST'], body: ['a'] }, createSupabase) {
  const { lines, logger } = memoryLogger()
  const route = createRoute({ getConfig: () => prodConfig(), createSupabase: createSupabase || (() => { throw new Error('no supabase') }), logger }, options, fn)
  return { route, lines }
}

test('success: JSON, no-store, request id, nosniff', async () => {
  const { route } = mk(async () => ({ body: { ok: true } }))
  const res = await route(makeRequest('/api/x', { body: { a: 1 } }))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control'), /no-store/)
  assert.match(res.headers.get('cache-control'), /private/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/)
  assert.deepEqual(await json(res), { ok: true })
})

test('405 for wrong method, with Allow', async () => {
  const { route } = mk(async () => ({ body: {} }))
  const res = await route(makeRequest('/api/x', { method: 'GET', origin: undefined, csrf: false }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'POST')
})

test('403 for bad origin / missing header, handler never runs', async () => {
  let ran = false
  const { route } = mk(async () => { ran = true; return { body: {} } })
  assert.equal((await route(makeRequest('/api/x', { body: { a: 1 }, origin: 'https://evil.example' }))).status, 403)
  assert.equal((await route(makeRequest('/api/x', { body: { a: 1 }, csrf: false }))).status, 403)
  assert.equal(ran, false)
})

test('415 for non-JSON content type', async () => {
  const { route } = mk(async () => ({ body: {} }))
  const res = await route(makeRequest('/api/x', { body: 'a=1', headers: { 'content-type': 'text/plain' } }))
  // makeRequest overrides content-type to JSON when a body is given, so build the request directly:
  const req = new Request('http://internal.invalid/api/x', { method: 'POST', headers: { origin: 'https://app.example.com', 'x-ombre-request': '1', 'content-type': 'text/plain' }, body: 'a=1' })
  assert.equal((await route(req)).status, 415)
  assert.ok(res.status === 400 || res.status === 200 || res.status === 415)
})

test('413 above the body limit (declared and actual)', async () => {
  const { route } = mk(async () => ({ body: {} }))
  const big = JSON.stringify({ a: 'x'.repeat(MAX_BODY_BYTES) })
  assert.equal((await route(makeRequest('/api/x', { body: big }))).status, 413)
  const noLength = new Request('http://internal.invalid/api/x', { method: 'POST', headers: { origin: 'https://app.example.com', 'x-ombre-request': '1', 'content-type': 'application/json' }, body: big })
  assert.equal((await route(noLength)).status, 413)
})

test('400 for invalid JSON, arrays, unknown keys', async () => {
  const { route } = mk(async () => ({ body: {} }))
  for (const body of ['{bad', '[1]', '{"a":1,"b":2}']) {
    const res = await route(makeRequest('/api/x', { body }))
    assert.equal(res.status, 400, body)
    assert.equal((await json(res)).error.code, 'invalid_request')
  }
})

test('unexpected errors are generic and never leak details', async () => {
  const { route, lines } = mk(async () => { throw new Error('boom: secret=hunter2 user@example.com') })
  const res = await route(makeRequest('/api/x', { body: { a: 1 } }))
  const text = await res.text()
  assert.equal(res.status, 500)
  assert.ok(!/hunter2|boom|user@example/.test(text))
  assert.equal(JSON.parse(text).error.code, 'internal_error')
  assert.ok(JSON.parse(text).error.requestId)
  assert.ok(lines.every((l) => !/hunter2|boom|user@example/.test(l)))
})

test('ApiError maps to its status with a fixed public message', async () => {
  const { route } = mk(async () => { throw new ApiError(401, 'invalid_credentials', { cause: new Error('db password=abc') }) })
  const res = await route(makeRequest('/api/x', { body: { a: 1 } }))
  const body = await json(res)
  assert.equal(res.status, 401)
  assert.equal(body.error.message, 'Email or password is incorrect.')
})

test('missing config produces a generic 500', async () => {
  const { lines, logger } = memoryLogger()
  const route = createRoute({ getConfig: () => { throw new Error('SUPABASE_URL is required.') }, createSupabase: () => null, logger }, { methods: ['POST'], body: ['a'] }, async () => ({ body: {} }))
  const res = await route(makeRequest('/api/x', { body: { a: 1 } }))
  assert.equal(res.status, 500)
  assert.ok(!(await res.clone().text()).includes('SUPABASE_URL'))
  assert.ok(lines.length > 0)
})

test('Set-Cookie headers from the jar are attached individually; library cache headers do not weaken no-store', async () => {
  const cfg = prodConfig()
  const createSupabase = () => ({
    supabase: {},
    jar: {
      extraHeaders: () => ({ 'Cache-Control': 'public, max-age=999', Pragma: 'no-cache' }),
      setCookieHeaders: () => ['a=1; Path=/', 'b=2; Path=/'],
    },
  })
  const { route } = mk(async (ctx) => { ctx.supa(); return { body: {} } }, { methods: ['POST'], body: null }, createSupabase)
  const res = await route(makeRequest('/api/x'))
  assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/'])
  assert.match(res.headers.get('cache-control'), /no-store/)
  assert.ok(cfg)
})

test('request log line has no body, cookie, header or email data', async () => {
  const { route, lines } = mk(async () => ({ body: {} }))
  await route(makeRequest('/api/x', { body: { a: 'secret-password-123' }, cookie: '__Host-ombre-auth=SESSIONSECRET' }))
  const all = lines.join('\n')
  assert.ok(!/secret-password|SESSIONSECRET/.test(all))
  const entry = JSON.parse(lines.find((l) => l.includes('api.request')))
  assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'event', 'level', 'method', 'path', 'requestId', 'status', 'ts'].sort())
})

test('logger redacts sensitive keys and scrubs emails, JWTs and long tokens', () => {
  const out = sanitizeFields({ password: 'x', email: 'a@b.co', accessToken: 'y', cookie: 'z', note: 'mail a@b.co jwt eyJhbGciOi.eyJzdWIi.sig token ' + 'A'.repeat(40), requestId: 'r1', errCode: 'invalid_credentials', nested: { a: 1 } })
  assert.equal(out.password, '[redacted]')
  assert.equal(out.email, '[redacted]')
  assert.equal(out.accessToken, '[redacted]')
  assert.equal(out.cookie, '[redacted]')
  assert.equal(out.requestId, 'r1')
  assert.equal(out.errCode, 'invalid_credentials')
  assert.equal(out.nested, '[object]')
  assert.ok(!/a@b\.co|eyJ|AAAA/.test(out.note))
  assert.ok(scrub('x'.repeat(500)).length <= 200)
  const lines = []
  createLogger({ write: (l) => lines.push(l), now: () => new Date(0) }).warn('e', { password: 'p' })
  assert.equal(JSON.parse(lines[0]).password, '[redacted]')
})
