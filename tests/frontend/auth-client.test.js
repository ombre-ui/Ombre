import test from 'node:test'
import assert from 'node:assert/strict'
import { apiRequest, CSRF_HEADER } from '../../src/lib/auth/api.js'
import { safeInternalPath, safeServerNext } from '../../src/lib/auth/paths.js'
import { messageForError } from '../../src/features/auth/authErrors.js'

function stubFetch(impl) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return impl(url, init)
  }
  return calls
}
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('apiRequest sends the CSRF header, same-origin credentials, no-store, and never a token', async () => {
  const calls = stubFetch(() => jsonResponse(200, { ok: true }))
  const r = await apiRequest('/api/auth/signin', { method: 'POST', body: { email: 'a@b.co', password: 'x' } })
  assert.equal(r.ok, true)
  const { init } = calls[0]
  assert.equal(init.headers[CSRF_HEADER], '1')
  assert.equal(init.headers['Content-Type'], 'application/json')
  assert.equal(init.credentials, 'same-origin')
  assert.equal(init.cache, 'no-store')
  assert.equal(init.redirect, 'error')
  assert.ok(!('Authorization' in init.headers))
})

test('apiRequest GET has no body or content-type; errors keep the server error shape', async () => {
  const calls = stubFetch(() => jsonResponse(401, { error: { code: 'invalid_credentials', message: 'x', requestId: 'r' } }))
  const r = await apiRequest('/api/auth/session')
  assert.equal(calls[0].init.body, undefined)
  assert.equal(calls[0].init.headers['Content-Type'], undefined)
  assert.equal(r.ok, false)
  assert.equal(r.status, 401)
  assert.equal(r.error.code, 'invalid_credentials')
})

test('apiRequest maps network failures and non-JSON bodies to safe results', async () => {
  stubFetch(() => { throw new TypeError('fetch failed') })
  const net = await apiRequest('/api/auth/session')
  assert.deepEqual([net.ok, net.status, net.error.code], [false, 0, 'network_error'])
  stubFetch(() => new Response('<html>502</html>', { status: 502 }))
  const bad = await apiRequest('/api/auth/session')
  assert.deepEqual([bad.ok, bad.status, bad.error.code], [false, 502, 'unknown'])
})

test('safeInternalPath only allows in-app paths', () => {
  assert.equal(safeInternalPath('/app/projects/abc?x=1#top'), '/app/projects/abc?x=1#top')
  assert.equal(safeInternalPath('/app/general'), '/app/general')
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/login', '/app//x', '/app/..\\x', 'app/general', undefined, null, 5, '/apple']) {
    assert.equal(safeInternalPath(bad), '/app/general', String(bad))
  }
})

test('safeServerNext accepts only known destinations', () => {
  assert.equal(safeServerNext('/reset-password'), '/reset-password')
  assert.equal(safeServerNext('/app/general'), '/app/general')
  assert.equal(safeServerNext('https://evil.com'), '/app/general')
  assert.equal(safeServerNext(undefined), '/app/general')
})

test('error messages are fixed strings, with a generic fallback', () => {
  assert.match(messageForError({ code: 'invalid_credentials', message: 'leak@example.com' }), /incorrect/)
  assert.ok(!messageForError({ code: 'invalid_credentials', message: 'leak@example.com' }).includes('leak'))
  assert.equal(messageForError({ code: 'nope' }), 'Something went wrong. Try again.')
  assert.equal(messageForError(null), 'Something went wrong. Try again.')
})
