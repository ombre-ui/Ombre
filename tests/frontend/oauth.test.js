import test from 'node:test'
import assert from 'node:assert/strict'
import { isSafeAuthorizeUrl, startOAuthRequest, classifyReturn, OAUTH_PROVIDERS } from '../../src/lib/auth/oauth.js'

const GOOD = 'https://abc.supabase.co/auth/v1/authorize?provider=github&code_challenge=x'
const q = (s) => new URLSearchParams(s)

test('only github is offered', () => {
  assert.deepEqual(OAUTH_PROVIDERS, ['github'])
})

test('isSafeAuthorizeUrl: https Supabase authorize URLs, and http only on localhost', () => {
  assert.equal(isSafeAuthorizeUrl(GOOD), true)
  assert.equal(isSafeAuthorizeUrl('http://127.0.0.1:54321/auth/v1/authorize?provider=github'), true)
  assert.equal(isSafeAuthorizeUrl('http://localhost:54321/auth/v1/authorize'), true)
  for (const bad of ['http://abc.supabase.co/auth/v1/authorize', 'https://abc.supabase.co/other', 'javascript:alert(1)', 'data:text/html,x', '//evil.example/auth/v1/authorize', 'not a url', '', undefined, null, 5]) {
    assert.equal(isSafeAuthorizeUrl(bad), false, String(bad))
  }
})

test('startOAuthRequest posts the provider, then navigates to the returned URL', async () => {
  const seen = []
  const nav = []
  const result = await startOAuthRequest('github', {
    request: async (path, opts) => { seen.push([path, opts]); return { ok: true, status: 200, data: { ok: true, url: GOOD } } },
    assign: (u) => nav.push(u),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [['/api/auth/oauth', { method: 'POST', body: { provider: 'github' } }]])
  assert.deepEqual(nav, [GOOD])
})

test('startOAuthRequest never navigates on failure, an unsafe URL or an unknown provider', async () => {
  const nav = []
  const assign = (u) => nav.push(u)
  const fail = await startOAuthRequest('github', { request: async () => ({ ok: false, status: 503, error: { code: 'service_unavailable', message: 'x' } }), assign })
  assert.deepEqual([fail.ok, fail.status], [false, 503])
  // The client cannot know the Supabase host (the server pins it); it still refuses other schemes and paths.
  const wrongPath = await startOAuthRequest('github', { request: async () => ({ ok: true, status: 200, data: { url: 'https://abc.supabase.co/other' } }), assign })
  assert.deepEqual([wrongPath.ok, wrongPath.error.code], [false, 'oauth_failed'])
  const script = await startOAuthRequest('github', { request: async () => ({ ok: true, status: 200, data: { url: 'javascript:alert(1)' } }), assign })
  assert.deepEqual([script.ok, script.error.code], [false, 'oauth_failed'])
  const none = await startOAuthRequest('github', { request: async () => ({ ok: true, status: 200, data: {} }), assign })
  assert.equal(none.ok, false)
  let called = false
  const unknown = await startOAuthRequest('google', { request: async () => { called = true; return { ok: true } }, assign })
  assert.equal(unknown.ok, false)
  assert.equal(called, false)
  assert.deepEqual(nav, [])
})

test('classifyReturn: a code, a cancellation, expired state and other failures', () => {
  assert.deepEqual(classifyReturn(q('code=abc12345&sb_flow_id=flow1234'), q('')), { kind: 'code', code: 'abc12345', flowId: 'flow1234' })
  assert.deepEqual(classifyReturn(q('code=abc12345'), q('')), { kind: 'code', code: 'abc12345', flowId: null })
  assert.deepEqual(classifyReturn(q('error=access_denied&error_description=The+user+denied'), q('')), { kind: 'cancelled' })
  assert.deepEqual(classifyReturn(q(''), q('error=access_denied')), { kind: 'cancelled' })
  assert.deepEqual(classifyReturn(q('error=server_error&error_code=bad_oauth_state'), q('')), { kind: 'expired' })
  assert.deepEqual(classifyReturn(q('error=server_error&error_code=unexpected_failure'), q('')), { kind: 'failed' })
  assert.deepEqual(classifyReturn(q('error=invalid_request'), q('')), { kind: 'failed' })
  assert.deepEqual(classifyReturn(q(''), q('')), { kind: 'failed' })
  // an error always wins over a code
  assert.deepEqual(classifyReturn(q('code=abc12345&error=access_denied'), q('')), { kind: 'cancelled' })
})

test('error descriptions are never part of the classification result', () => {
  const r = classifyReturn(q('error=access_denied&error_description=SECRET-DETAIL'), q(''))
  assert.ok(!JSON.stringify(r).includes('SECRET'))
})
