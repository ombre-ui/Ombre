import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeRequest, json } from './helpers.js'
import { PLATFORM_REWRITE_PARAMS, parseQuery, limitParam } from '../../api/_lib/params.js'
import { ApiError } from '../../api/_lib/errors.js'
import { ID1, buildWorkspace, conversationRow, ok, projectRow } from './workspace-helpers.js'

const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))
const FAMILIES = 'projects|conversations|saved|library'

// The nine public URLs reach the single function through vercel.json rewrites.
test('vercel.json rewrites the four A4 families to the single workspace function, before the SPA fallback', () => {
  const [first, second, spa, ...rest] = vercel.rewrites
  assert.equal(rest.length, 0)
  for (const rule of [first, second]) {
    assert.equal(rule.destination, '/api/workspace')
    assert.match(rule.source, new RegExp(`:__vf\\(${FAMILIES}\\)`))
  }
  assert.equal(first.source, `/api/:__vf(${FAMILIES})`)
  assert.equal(second.source, `/api/:__vf(${FAMILIES})/:__vp*`)
  assert.equal(spa.destination, '/index.html')
  assert.match(spa.source, /\?!api\//, 'the SPA fallback must keep excluding /api/')
  // Only the reserved (ignored) parameter names appear, so a platform-appended query can never be mistaken for input.
  for (const rule of [first, second]) {
    const names = [...rule.source.matchAll(/:(\w+)/g)].map((m) => m[1])
    for (const name of names) assert.ok(PLATFORM_REWRITE_PARAMS.includes(name), name)
  }
})

test('the rewrite sources match exactly the public A4 URLs and nothing else under /api', () => {
  const matchers = [`^/api/(?:${FAMILIES})$`, `^/api/(?:${FAMILIES})/.+$`].map((p) => new RegExp(p))
  const matches = (path) => matchers.some((re) => re.test(path))
  const yes = [
    '/api/projects',
    `/api/projects/${ID1}`,
    '/api/conversations',
    `/api/conversations/${ID1}`,
    `/api/conversations/${ID1}/messages`,
    '/api/saved',
    `/api/saved/${ID1}`,
    '/api/library',
    `/api/library/${ID1}`,
  ]
  const no = ['/api/auth/signin', '/api/auth/session', '/api/user/profile', '/api/user/settings', '/api/projectsx', '/api/library-other', '/api/workspace', '/projects']
  for (const path of yes) assert.equal(matches(path), true, path)
  for (const path of no) assert.equal(matches(path), false, path)
})

test('the API security headers in vercel.json are unchanged', () => {
  const api = vercel.headers.find((h) => h.source === '/api/(.*)')
  assert.ok(api)
  const byKey = Object.fromEntries(api.headers.map((h) => [h.key, h.value]))
  assert.equal(byKey['Content-Security-Policy'], "default-src 'none'; frame-ancestors 'none'")
  assert.match(byKey['Cache-Control'], /no-store/)
  assert.equal(byKey['X-Frame-Options'], 'DENY')
  assert.equal(byKey['X-Content-Type-Options'], 'nosniff')
})

test('platform rewrite parameters are ignored, but every other unknown parameter is still rejected', () => {
  const spec = { limit: limitParam() }
  assert.deepEqual(parseQuery(new URL('http://x/api/projects?__vf=projects&__vp=a%2Fb&limit=5'), spec), { limit: 5 })
  assert.deepEqual(parseQuery(new URL('http://x/api/projects?__vf=projects'), spec), {})
  assert.throws(() => parseQuery(new URL('http://x/api/projects?__vf=projects&other=1'), spec), (e) => e instanceof ApiError && e.status === 400)
  assert.throws(() => parseQuery(new URL('http://x/api/projects?__vx=1'), spec), (e) => e instanceof ApiError && e.status === 400)
})

test('requests as the platform delivers them (original path plus appended rewrite params) are served', async () => {
  const handler = (p) => (p.table === 'projects' ? ok([projectRow()]) : ok([conversationRow()]))
  const { routes } = buildWorkspace({ handler })
  const list = await routes.workspace(makeRequest('/api/projects?__vf=projects&limit=5', { method: 'GET' }))
  assert.equal(list.status, 200)
  const one = await routes.workspace(makeRequest(`/api/projects/${ID1}?__vf=projects&__vp=${ID1}`, { method: 'GET' }))
  assert.equal(one.status, 200)
  const bad = await routes.workspace(makeRequest('/api/projects?__vf=projects&nope=1', { method: 'GET' }))
  assert.equal(bad.status, 400)
  assert.equal((await json(bad)).error.code, 'invalid_request')
})
