import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRequest, json } from './helpers.js'
import { toNode } from '../../api/_lib/node.js'
import { ID1, ID2, KEY1, buildWorkspace, conversationRow, messageRow, ok, projectRow } from './workspace-helpers.js'

const GET = { method: 'GET' }

// Every public A4 URL and method, exactly as specified in the approved contract. Each case says which table the
// database call must touch, which proves the right route handled it.
const PUBLIC_ROUTES = [
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
  ['GET', `/api/conversations/${ID1}/messages`, undefined, 'conversations'], // one embedded query on conversations
  ['POST', `/api/conversations/${ID1}/messages`, { role: 'user', content: 'Hi', clientRequestId: KEY1 }, 'messages'],
  ['GET', '/api/saved', undefined, 'saved_items'],
  ['POST', '/api/saved', { conversationId: ID2 }, 'saved_items'],
  ['DELETE', `/api/saved/${ID1}`, undefined, 'saved_items'],
  ['GET', '/api/library', undefined, 'library_items'],
  ['GET', `/api/library/${ID1}`, undefined, 'library_items'],
]

const handler = (payload) => {
  if (payload.rpc) return ok({ conversation: conversationRow(), message: messageRow() })
  if (payload.table === 'projects') return ok([projectRow()])
  if (payload.table === 'conversations') return ok([{ ...conversationRow(), messages: [messageRow()] }])
  if (payload.table === 'messages') return ok([messageRow()])
  if (payload.table === 'saved_items') return ok([{ id: ID1, conversation_id: ID2, message_id: null, created_at: '2026-10-20T03:30:00.000001+00:00' }])
  return ok([{ id: ID1, project_id: null, source: 'user', kind: 'note', title: 'T', preview: '', created_at: '2026-10-20T03:30:00.000001+00:00' }])
}

test('the dispatcher serves every public A4 URL and method through the right route', async () => {
  for (const [method, path, body, touches] of PUBLIC_ROUTES) {
    const { routes, calls } = buildWorkspace({ handler })
    const res = await routes.workspace(makeRequest(path, { method, body }))
    assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} -> ${res.status}`)
    const call = calls.find((c) => c.table || c.rpc)
    assert.equal(call.rpc ? `rpc:${call.rpc}` : call.table, touches, `${method} ${path}`)
  }
})

test('the dispatcher keeps each route\'s own method handling (405 with Allow)', async () => {
  const { routes, calls } = buildWorkspace({ handler })
  const cases = [
    ['PUT', '/api/projects', 'GET, POST'],
    ['DELETE', '/api/projects', 'GET, POST'],
    ['POST', `/api/projects/${ID1}`, 'GET, PATCH, DELETE'],
    ['PATCH', `/api/conversations/${ID1}/messages`, 'GET, POST'],
    ['DELETE', `/api/conversations/${ID1}/messages`, 'GET, POST'],
    ['PATCH', `/api/saved/${ID1}`, 'DELETE'],
    ['GET', `/api/saved/${ID1}`, 'DELETE'],
    ['POST', '/api/library', 'GET'],
    ['DELETE', `/api/library/${ID1}`, 'GET'],
  ]
  for (const [method, path, allow] of cases) {
    const res = await routes.workspace(makeRequest(path, { method, body: ['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined }))
    assert.equal(res.status, 405, `${method} ${path}`)
    assert.equal(res.headers.get('allow'), allow, `${method} ${path}`)
  }
  assert.equal(calls.length, 0)
})

test('unknown shapes and other families get the generic 404, never a route', async () => {
  const { routes, calls } = buildWorkspace({ handler })
  const paths = [
    '/api',
    '/api/',
    '/api/nope',
    '/api/projects/x/y',
    `/api/projects/${ID1}/messages`,
    `/api/conversations/${ID1}/messages/${ID2}`,
    `/api/conversations/${ID1}/other`,
    `/api/saved/${ID1}/x`,
    '/api/library/a/b/c',
    '/api/auth/unknown',
    '/api/user/unknown',
    '/api/constructor',
    '/api/__proto__/x',
    '/other/projects',
    '/projects',
  ]
  for (const path of paths) {
    const res = await routes.workspace(makeRequest(path, GET))
    assert.equal(res.status, 404, path)
    const body = await json(res)
    assert.equal(body.error.code, 'not_found')
    assert.match(res.headers.get('cache-control'), /no-store/)
  }
  assert.equal(calls.length, 0, 'unknown paths must never reach the database or authentication')
})

test('behaviour behind the dispatcher is unchanged: auth, strict ids, CSRF, uniform errors', async () => {
  const noSession = Object.assign(new Error('x'), { name: 'AuthSessionMissingError', status: 400 })
  const anon = buildWorkspace({ authError: noSession, handler })
  for (const [method, path, body] of PUBLIC_ROUTES.filter((r) => r[0] === 'GET' || r[0] === 'DELETE')) {
    assert.equal((await anon.routes.workspace(makeRequest(path, { method, body }))).status, 401, path)
  }
  const { routes } = buildWorkspace({ handler })
  assert.equal((await routes.workspace(makeRequest('/api/projects/not-a-uuid', GET))).status, 400)
  assert.equal((await routes.workspace(makeRequest(`/api/projects/${ID1.toUpperCase()}`, GET))).status, 400)
  assert.equal((await routes.workspace(makeRequest('/api/projects', { body: { name: 'A' }, csrf: false }))).status, 403)
  assert.equal((await routes.workspace(makeRequest('/api/projects', { body: { name: 'A' }, origin: 'https://evil.example' }))).status, 403)
  assert.equal((await routes.workspace(makeRequest('/api/projects', { body: { name: 'A', user_id: ID1 } }))).status, 400)
  assert.equal((await routes.workspace(makeRequest('/api/projects?limit=0', GET))).status, 400)
})

test('through the Node adapter each route still enforces its own body limit', async () => {
  const { routes } = buildWorkspace({ handler })
  const node = toNode(routes.workspace)
  assert.equal(routes.workspace.maxBodyBytes, 40960)
  const run = async (path, size) => {
    const payload = Buffer.from(JSON.stringify(path.includes('messages') || path === '/api/conversations'
      ? { role: 'user', content: 'a'.repeat(size), clientRequestId: KEY1 }
      : { name: 'a'.repeat(size) }))
    const req = (async function* () {
      yield payload
    })()
    req.method = 'POST'
    req.url = path
    req.headers = { origin: 'https://app.example.com', 'x-ombre-request': '1', 'content-type': 'application/json' }
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, end(c) { this.body = c ? Buffer.from(c).toString('utf8') : '' } }
    await node(req, res)
    return res.statusCode
  }
  // projects: 4096-byte route limit, even though the adapter buffers up to 40960
  assert.equal(await run('/api/projects', 5000), 413)
  assert.equal(await run('/api/projects', 50), 201)
  // messages: 40960-byte route limit
  assert.equal(await run(`/api/conversations/${ID1}/messages`, 8000), 201)
  assert.equal(await run(`/api/conversations/${ID1}/messages`, 45000), 413)
})

// The Hobby plan allows 12 serverless functions per deployment. Vercel makes one function per file under api/
// (files and directories starting with "_" are ignored). This guard fails the unit tests, long before a deploy,
// if the count would exceed the limit, and pins the A4 packaging (one function, reached through rewrites).
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url))
function functionFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...functionFiles(full))
    else if (/\.(js|mjs|cjs|ts)$/.test(name)) out.push(relative(API_DIR, full).split('\\').join('/'))
  }
  return out.sort()
}

test('the deployment stays within the 12-function Hobby limit, with A4 as a single function', () => {
  const files = functionFiles(API_DIR)
  assert.ok(files.length <= 12, `${files.length} functions: ${files.join(', ')}`)
  assert.ok(files.includes('workspace.js'), 'A4 is served by api/workspace.js (reached through the vercel.json rewrites)')
  assert.equal(files.includes('[...path].js'), false, 'a catch-all file does not match multi-segment paths on Vercel')
  const perRoute = files.filter((f) => /^(projects|conversations|saved|library)\//.test(f))
  assert.deepEqual(perRoute, [], 'no per-route A4 function files')
})
