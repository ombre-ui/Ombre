import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRequest, json } from './helpers.js'
import { PLATFORM_REWRITE_PARAMS } from '../../api/_lib/params.js'
import { ID1, ID2, ID3, KEY1, USER, buildWorkspace, conversationRow, messageRow, ok, opsOf, projectRow } from './workspace-helpers.js'

// Evidence for the __vf / __vp exception (see vercel.json). On a Vercel preview, GET
// /api/conversations/<id>/messages?limit=7 reached the function with THREE query parameters: limit plus the
// platform-injected __vf and __vp. Without the exception every rewritten request would be a 400.
//
//   1. they are internal: referenced only by the strict parser's ignore-list and the vercel.json rewrites;
//   2. a client cannot use them to change route selection, the ids used, or authorization;
//   3. every other unknown or repeated query parameter is still a 400, on all nine routes.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
function sourceFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(js|jsx|mjs|json)$/.test(name)) out.push(relative(ROOT, full).split('\\').join('/'))
  }
  return out
}

test('1. __vf and __vp appear only in the ignore-list, the rewrites and the tests', () => {
  assert.deepEqual([...PLATFORM_REWRITE_PARAMS], ['__vf', '__vp'])
  const users = [...sourceFiles(join(ROOT, 'api')), ...sourceFiles(join(ROOT, 'src')), 'vercel.json', 'vercel-dev.json']
    .filter((f) => /__v[fp]|PLATFORM_REWRITE_PARAMS/.test(readFileSync(join(ROOT, f), 'utf8')))
    .sort()
  assert.deepEqual(users, ['api/_lib/params.js', 'vercel-dev.json', 'vercel.json'])
})

const PUBLIC = [
  ['GET', '/api/projects', undefined, 'projects'],
  ['POST', '/api/projects', { name: 'A' }, 'projects'],
  ['GET', `/api/projects/${ID1}`, undefined, 'projects'],
  ['PATCH', `/api/projects/${ID1}`, { name: 'B' }, 'projects'],
  ['DELETE', `/api/projects/${ID1}`, undefined, 'projects'],
  ['GET', '/api/conversations', undefined, 'conversations'],
  ['POST', '/api/conversations', { content: 'Hi', clientRequestId: KEY1 }, 'rpc:create_conversation'],
  ['GET', `/api/conversations/${ID1}`, undefined, 'conversations'],
  ['PATCH', `/api/conversations/${ID1}`, { title: 'T' }, 'conversations'],
  ['DELETE', `/api/conversations/${ID1}`, undefined, 'conversations'],
  ['GET', `/api/conversations/${ID1}/messages`, undefined, 'conversations'],
  ['POST', `/api/conversations/${ID1}/messages`, { role: 'user', content: 'Hi', clientRequestId: KEY1 }, 'messages'],
  ['GET', '/api/saved', undefined, 'saved_items'],
  ['POST', '/api/saved', { conversationId: ID2 }, 'saved_items'],
  ['DELETE', `/api/saved/${ID1}`, undefined, 'saved_items'],
  ['GET', '/api/library', undefined, 'library_items'],
  ['GET', `/api/library/${ID1}`, undefined, 'library_items'],
]
const handler = (p) => {
  if (p.rpc) return ok({ conversation: conversationRow(), message: messageRow() })
  if (p.table === 'projects') return ok([projectRow()])
  if (p.table === 'conversations') return ok([{ ...conversationRow(), messages: [messageRow()] }])
  if (p.table === 'messages') return ok([messageRow()])
  if (p.table === 'saved_items') return ok([{ id: ID1, conversation_id: ID2, message_id: null, created_at: '2026-10-20T03:30:00.000001+00:00' }])
  return ok([{ id: ID1, project_id: null, source: 'user', kind: 'note', title: 'T', preview: '', created_at: '2026-10-20T03:30:00.000001+00:00' }])
}
const target = (call) => (call.rpc ? `rpc:${call.rpc}` : call.table)
const idFilters = (call) => opsOf(call, 'eq').filter((o) => o[1] === 'id' || o[1] === 'user_id').map((o) => o.slice(1))

test('2a. hostile __vf/__vp values never change which route runs, which ids are queried, or the owner filter', async () => {
  const hostile = `__vf=library&__vp=${ID3}%2Fmessages`
  for (const [method, path, body, touches] of PUBLIC) {
    const plain = buildWorkspace({ handler })
    const attacked = buildWorkspace({ handler })
    const a = await plain.routes.workspace(makeRequest(path, { method, body }))
    const b = await attacked.routes.workspace(makeRequest(`${path}?${hostile}`, { method, body }))
    assert.equal(b.status, a.status, `${method} ${path}`)
    const callA = plain.calls.find((c) => c.table || c.rpc)
    const callB = attacked.calls.find((c) => c.table || c.rpc)
    assert.equal(target(callB), touches, `${method} ${path}`)
    assert.equal(target(callB), target(callA))
    assert.deepEqual(idFilters(callB), idFilters(callA), 'ids and owner come only from the path and the session')
    for (const [, id] of idFilters(callB)) assert.notEqual(id, ID3)
    assert.equal(JSON.stringify(callB.args ?? callB.ops).includes(ID3), false, 'a __vp value must never reach a query')
    if (touches !== 'library_items') assert.equal(JSON.stringify(callB.ops).includes('library'), false)
  }
})

test('2b. route selection depends on the pathname only, and the function path itself selects nothing', async () => {
  const { routes, calls } = buildWorkspace({ handler })
  assert.equal(routes.workspace.select('/api/projects'), routes.projectsIndex)
  // the query string is not even an input to select()
  assert.equal(routes.workspace.select.length, 1)
  for (const path of ['/api/workspace', '/api/workspace/projects', `/api/workspace/projects/${ID1}`]) {
    const res = await routes.workspace(makeRequest(`${path}?__vf=projects&__vp=${ID1}`, { method: 'GET' }))
    assert.equal(res.status, 404, path)
    assert.equal((await json(res)).error.code, 'not_found')
  }
  assert.equal(calls.length, 0, 'forged rewrite parameters on the function path reach neither the database nor authentication')
})

test('2c. hostile rewrite parameters grant no access: auth, CSRF and mass-assignment checks all still apply', async () => {
  const hostile = `?__vf=projects&__vp=${ID3}`
  const noSession = Object.assign(new Error('x'), { name: 'AuthSessionMissingError', status: 400 })
  const anon = buildWorkspace({ authError: noSession, handler })
  for (const [method, path, body] of PUBLIC) {
    assert.equal((await anon.routes.workspace(makeRequest(path + hostile, { method, body }))).status, 401, `${method} ${path}`)
  }
  assert.equal(anon.calls.filter((c) => c.table || c.rpc).length, 0)
  const { routes } = buildWorkspace({ handler })
  assert.equal((await routes.workspace(makeRequest(`/api/projects${hostile}`, { body: { name: 'A' }, csrf: false }))).status, 403)
  assert.equal((await routes.workspace(makeRequest(`/api/projects${hostile}`, { body: { name: 'A' }, origin: 'https://evil.example' }))).status, 403)
  assert.equal((await routes.workspace(makeRequest(`/api/projects${hostile}`, { body: { name: 'A', user_id: ID3 } }))).status, 400)
  assert.equal((await routes.workspace(makeRequest(`/api/projects/not-a-uuid${hostile}`, { method: 'GET' }))).status, 400)
  const other = buildWorkspace({ user: { id: USER }, handler: () => ok([]) })
  assert.equal((await other.routes.workspace(makeRequest(`/api/projects/${ID2}${hostile}`, { method: 'GET' }))).status, 404)
})

test('3. every other unknown or repeated query parameter is still a 400 on all nine routes', async () => {
  for (const [method, path, body] of PUBLIC) {
    const { routes, calls } = buildWorkspace({ handler })
    for (const q of ['foo=1', '__vx=1', '__VF=1', 'vf=1', '__vf=a&foo=1', 'limit=5&limit=6']) {
      const res = await routes.workspace(makeRequest(`${path}?${q}`, { method, body }))
      assert.equal(res.status, 400, `${method} ${path}?${q}`)
    }
    assert.equal(calls.filter((c) => c.table || c.rpc).length, 0, `${method} ${path}: rejected before any database call`)
  }
})

test('3b. the reserved names are tolerated alongside valid parameters, and only those', async () => {
  const { routes } = buildWorkspace({ handler })
  const ok1 = await routes.workspace(makeRequest('/api/projects?limit=5&__vf=projects', { method: 'GET' }))
  assert.equal(ok1.status, 200)
  const ok2 = await routes.workspace(makeRequest(`/api/conversations/${ID1}/messages?limit=5&after=0&__vf=conversations&__vp=${ID1}%2Fmessages`, { method: 'GET' }))
  assert.equal(ok2.status, 200)
})
