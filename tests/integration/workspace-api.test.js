// A4 workspace API against a REAL local Supabase stack (`supabase start`): the real workspace routes (the same dispatcher
// api/workspace.js serves), real @supabase/ssr cookies, the pinned supabase-js client, real PostgREST, real RLS and
// triggers, two separate users. Nothing is mocked. Skipped unless AUTH_INTEGRATION=1.
//
// This is what proves the PostgREST syntax the routes rely on actually works (embedded counts through a composite foreign
// key, referenced-table filter/order/limit on embedded messages) and that keyset pagination is stable with equal timestamps.
//
// Required env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY. Emails come from Mailpit at MAIL_API.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

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
    const text = await res.text() // 204 responses have no body
    return { status: res.status, body: text ? JSON.parse(text) : null }
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
  const email = `a4-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const b = browser(routes)
  assert.equal((await b.call('signup', { path: '/api/auth/signup', body: { email, password: PASSWORD } })).status, 200)
  const code = await codeFromLink(await latestMailLink(email, /confirm/i))
  assert.equal((await b.call('callback', { path: '/api/auth/callback', body: { code } })).status, 200)
  const me = (await b.call('session', { method: 'GET', path: '/api/auth/session' })).body.user
  assert.equal(me.email, email)
  return { b, email, id: me.id }
}

const ws = (user, method, path, body) => user.b.call('workspace', { method, path, body })
const newKey = () => randomUUID()

// Pages through a list endpoint with the given page size and returns every item, asserting the cursor chain terminates.
async function pageAll(user, path, key, limit) {
  const items = []
  let cursor = null
  for (let i = 0; i < 30; i += 1) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await ws(user, 'GET', `${path}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    items.push(...res.body[key])
    cursor = res.body.nextCursor
    if (!cursor) return items
  }
  throw new Error('pagination did not terminate')
}

suite('workspace API end to end on real PostgREST: lists, embeds, pagination, idempotency, isolation, history gate, cascades', async () => {
  process.env.APP_ORIGINS = ORIGIN
  process.env.AUTH_ALLOW_INSECURE_COOKIES = 'true'
  const { routes } = await import('../../api/_lib/real.js')
  const { loadConfig } = await import('../../api/_lib/config.js')
  const { createSupabaseForRequest } = await import('../../api/_lib/supabase.js')

  const A = await signedInUser(routes, 'a')
  const B = await signedInUser(routes, 'b')
  const config = loadConfig({ ...process.env })
  // The user's own real session straight against PostgREST (used for bulk inserts that share one transaction timestamp).
  const directA = createSupabaseForRequest(new Request('http://internal.invalid/x', { headers: { cookie: A.b.cookieHeader() } }), config).supabase

  // ---- signed out: nothing is reachable
  const anon = browser(routes)
  for (const [method, path] of [['GET', '/api/projects'], ['GET', '/api/conversations'], ['GET', '/api/saved'], ['GET', '/api/library'], ['GET', `/api/conversations/${randomUUID()}/messages`]]) {
    assert.equal((await anon.call('workspace', { method, path })).status, 401, path)
  }

  // ---- projects: create, list with the embedded conversation count (composite-FK embed), archive filter
  const p1 = (await ws(A, 'POST', '/api/projects', { name: 'Alpha', description: 'first' })).body.project
  const p2 = (await ws(A, 'POST', '/api/projects', { name: 'Beta' })).body.project
  assert.ok(p1.id && p2.id)
  const c1 = await ws(A, 'POST', '/api/conversations', { content: 'in alpha one', clientRequestId: newKey(), projectId: p1.id })
  const c2 = await ws(A, 'POST', '/api/conversations', { content: 'in alpha two', clientRequestId: newKey(), projectId: p1.id, mentorId: 'bug-hunter' })
  assert.equal(c1.status, 201)
  assert.equal(c2.status, 201)
  assert.equal(c2.body.conversation.mentorId, 'bug-hunter')
  const listed = (await ws(A, 'GET', '/api/projects')).body.projects
  assert.equal(listed.find((p) => p.id === p1.id).conversationCount, 2, 'embedded count through conversations_project_fk')
  assert.equal(listed.find((p) => p.id === p2.id).conversationCount, 0, 'a project with no conversations counts 0')
  assert.equal((await ws(A, 'GET', `/api/projects/${p1.id}`)).body.project.conversationCount, 2)
  assert.equal((await ws(A, 'PATCH', `/api/projects/${p2.id}`, { archived: true })).status, 200)
  assert.ok(!(await ws(A, 'GET', '/api/projects')).body.projects.some((p) => p.id === p2.id))
  assert.ok((await ws(A, 'GET', '/api/projects?status=archived')).body.projects.some((p) => p.id === p2.id))
  assert.equal((await ws(A, 'PATCH', `/api/projects/${p2.id}`, { archived: false })).body.project.archivedAt, null)

  // ---- keyset pagination with EQUAL timestamps (one INSERT statement => one transaction timestamp)
  const tied = await directA.from('projects').insert(Array.from({ length: 5 }, (_, i) => ({ name: `tie-${i}` }))).select('id,updated_at')
  assert.equal(tied.error, null)
  assert.equal(new Set(tied.data.map((r) => r.updated_at)).size, 1, 'premise: the five rows share one updated_at')
  const allProjects = await pageAll(A, '/api/projects', 'projects', 3)
  assert.equal(allProjects.length, 7, 'two created through the API plus five tied rows')
  assert.equal(new Set(allProjects.map((p) => p.id)).size, 7, 'no row repeated across pages')
  for (let i = 1; i < allProjects.length; i += 1) {
    const prev = allProjects[i - 1]
    const cur = allProjects[i]
    assert.ok(prev.updatedAt > cur.updatedAt || (prev.updatedAt === cur.updatedAt && prev.id > cur.id), 'ordered by (updated_at desc, id desc)')
  }
  const bigPage = (await ws(A, 'GET', '/api/projects?limit=50')).body
  assert.deepEqual(bigPage.projects.map((p) => p.id), allProjects.map((p) => p.id), 'page size does not change the order')
  assert.equal(bigPage.nextCursor, null)

  const tiedConvs = await directA.from('conversations').insert(Array.from({ length: 5 }, (_, i) => ({ title: `tie-conv-${i}` }))).select('id,last_message_at')
  assert.equal(tiedConvs.error, null)
  assert.equal(new Set(tiedConvs.data.map((r) => r.last_message_at)).size, 1, 'premise: the five conversations share one last_message_at')
  const allConvs = await pageAll(A, '/api/conversations', 'conversations', 2)
  assert.equal(allConvs.length, 7)
  assert.equal(new Set(allConvs.map((c) => c.id)).size, 7)
  const inAlpha = await pageAll(A, `/api/conversations?projectId=${p1.id}`, 'conversations', 1)
  assert.equal(inAlpha.length, 2)
  assert.ok(inAlpha.every((c) => c.projectId === p1.id))

  // ---- messages: embedded referenced-table filter, order and limit
  const conv = c1.body.conversation
  const roles = ['assistant', 'user', 'assistant', 'user', 'assistant']
  for (const [i, role] of roles.entries()) {
    const res = await ws(A, 'POST', `/api/conversations/${conv.id}/messages`, { role, content: `message ${i + 2}`, clientRequestId: newKey() })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.message.seq, i + 2)
    assert.equal(res.body.message.demo, role === 'assistant')
    assert.equal(res.body.message.status, 'complete')
  }
  const seqs = (r) => r.body.messages.map((m) => m.seq)
  const all = await ws(A, 'GET', `/api/conversations/${conv.id}/messages`)
  assert.deepEqual(seqs(all), [1, 2, 3, 4, 5, 6], 'embedded order ascending by seq')
  assert.equal(all.body.nextCursor, null)
  const limited = await ws(A, 'GET', `/api/conversations/${conv.id}/messages?limit=2`)
  assert.deepEqual(seqs(limited), [1, 2], 'referenced-table limit')
  assert.equal(limited.body.nextCursor, 2)
  const second = await ws(A, 'GET', `/api/conversations/${conv.id}/messages?limit=2&after=2`)
  assert.deepEqual(seqs(second), [3, 4], 'referenced-table filter (gt) + limit + order')
  assert.equal(second.body.nextCursor, 4)
  const third = await ws(A, 'GET', `/api/conversations/${conv.id}/messages?limit=2&after=4`)
  assert.deepEqual(seqs(third), [5, 6])
  assert.equal(third.body.nextCursor, null)
  const beyond = await ws(A, 'GET', `/api/conversations/${conv.id}/messages?after=6`)
  assert.deepEqual(seqs(beyond), [])
  assert.equal(beyond.status, 200, 'an existing conversation with no later messages is an empty page, not a 404')
  assert.equal((await ws(A, 'GET', `/api/conversations/${conv.id}`)).body.conversation.messageCount, 6)
  assert.deepEqual(all.body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])

  // ---- idempotency end to end (replay returns the original; a conflicting payload is a 409; nothing is duplicated)
  const key = newKey()
  const created = await ws(A, 'POST', '/api/conversations', { content: 'idempotent', clientRequestId: key })
  assert.equal(created.status, 201)
  const replay = await ws(A, 'POST', '/api/conversations', { content: 'idempotent', clientRequestId: key })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.conversation.id, created.body.conversation.id)
  assert.equal(replay.body.message.id, created.body.message.id)
  const conflict = await ws(A, 'POST', '/api/conversations', { content: 'something else', clientRequestId: key })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'conflict')
  const convoCount = (await pageAll(A, '/api/conversations', 'conversations', 50)).length
  assert.equal(convoCount, 8, 'the retry and the conflict created nothing')
  const mkey = newKey()
  const m1 = await ws(A, 'POST', `/api/conversations/${created.body.conversation.id}/messages`, { role: 'user', content: 'again', clientRequestId: mkey })
  const m2 = await ws(A, 'POST', `/api/conversations/${created.body.conversation.id}/messages`, { role: 'user', content: 'again', clientRequestId: mkey })
  assert.equal(m1.status, 201)
  assert.equal(m2.status, 200)
  assert.equal(m2.body.message.id, m1.body.message.id)
  assert.equal((await ws(A, 'POST', `/api/conversations/${created.body.conversation.id}/messages`, { role: 'user', content: 'changed', clientRequestId: mkey })).status, 409)
  assert.equal((await ws(A, 'GET', `/api/conversations/${created.body.conversation.id}`)).body.conversation.messageCount, 2)

  // ---- cross-tenant: B cannot see, attach to, post into, change, bookmark or delete A's data (always 404)
  assert.deepEqual((await ws(B, 'GET', '/api/projects')).body.projects, [])
  assert.deepEqual((await ws(B, 'GET', '/api/conversations')).body.conversations, [])
  for (const [method, path, body] of [
    ['GET', `/api/projects/${p1.id}`],
    ['PATCH', `/api/projects/${p1.id}`, { name: 'stolen' }],
    ['DELETE', `/api/projects/${p1.id}`],
    ['GET', `/api/conversations/${conv.id}`],
    ['PATCH', `/api/conversations/${conv.id}`, { title: 'stolen' }],
    ['DELETE', `/api/conversations/${conv.id}`],
    ['GET', `/api/conversations/${conv.id}/messages`],
    ['POST', `/api/conversations/${conv.id}/messages`, { role: 'user', content: 'intrusion', clientRequestId: newKey() }],
    ['POST', '/api/conversations', { content: 'into a foreign project', clientRequestId: newKey(), projectId: p1.id }],
    ['POST', '/api/saved', { conversationId: conv.id }],
  ]) {
    const res = await ws(B, method, path, body)
    assert.equal(res.status, 404, `${method} ${path}`)
    assert.equal(res.body.error.code, 'not_found')
  }
  const bOwn = (await ws(B, 'POST', '/api/conversations', { content: 'b conversation', clientRequestId: newKey() })).body.conversation
  assert.equal((await ws(B, 'PATCH', `/api/conversations/${bOwn.id}`, { projectId: p1.id })).status, 404, 'moving into a foreign project fails the composite FK')
  assert.equal((await ws(A, 'GET', `/api/projects/${p1.id}`)).body.project.name, 'Alpha')
  assert.equal((await ws(A, 'GET', `/api/conversations/${conv.id}`)).body.conversation.title, 'in alpha one')
  assert.equal((await ws(A, 'GET', `/api/conversations/${conv.id}/messages`)).body.messages.length, 6)

  // ---- save_history gate through the real settings route, with a toggle between requests
  const sConv = (await ws(A, 'POST', '/api/conversations', { content: 'gate start', clientRequestId: newKey() })).body.conversation
  assert.equal((await A.b.call('settings', { method: 'PATCH', path: '/api/user/settings', body: { privacy: { saveHistory: false } } })).status, 200)
  const off1 = await ws(A, 'POST', '/api/conversations', { content: 'must not persist', clientRequestId: newKey() })
  assert.equal(off1.status, 409)
  assert.equal(off1.body.error.code, 'history_disabled')
  const off2 = await ws(A, 'POST', `/api/conversations/${sConv.id}/messages`, { role: 'user', content: 'must not persist', clientRequestId: newKey() })
  assert.equal(off2.status, 409)
  assert.equal(off2.body.error.code, 'history_disabled')
  assert.equal((await ws(A, 'GET', `/api/conversations/${sConv.id}`)).body.conversation.messageCount, 1, 'the refused write did not move the counter')
  assert.equal((await ws(A, 'GET', `/api/conversations/${sConv.id}/messages`)).status, 200, 'reading still works while history is off')
  assert.equal((await ws(A, 'PATCH', `/api/conversations/${sConv.id}`, { title: 'renamed while off' })).status, 200)
  assert.equal((await A.b.call('settings', { method: 'PATCH', path: '/api/user/settings', body: { privacy: { saveHistory: true } } })).status, 200)
  const on = await ws(A, 'POST', `/api/conversations/${sConv.id}/messages`, { role: 'user', content: 'back on', clientRequestId: newKey() })
  assert.equal(on.status, 201)
  assert.equal(on.body.message.seq, 2, 'no sequence number was burned by the refused write')

  // ---- saved: create, idempotent duplicate, list, delete
  const target = all.body.messages[1]
  const s1 = await ws(A, 'POST', '/api/saved', { conversationId: conv.id, messageId: target.id })
  assert.equal(s1.status, 201)
  const s1again = await ws(A, 'POST', '/api/saved', { conversationId: conv.id, messageId: target.id })
  assert.equal(s1again.status, 200)
  assert.equal(s1again.body.item.id, s1.body.item.id)
  const sWhole = await ws(A, 'POST', '/api/saved', { conversationId: conv.id })
  assert.equal(sWhole.status, 201)
  assert.equal((await ws(A, 'POST', '/api/saved', { conversationId: conv.id })).body.item.id, sWhole.body.item.id)
  assert.equal((await ws(A, 'POST', '/api/saved', { conversationId: sConv.id, messageId: target.id })).status, 404, 'a message must belong to the conversation it is saved under')
  assert.equal((await pageAll(A, '/api/saved', 'items', 1)).length, 2)
  assert.deepEqual((await ws(B, 'GET', '/api/saved')).body.items, [])

  // ---- library: read-only, nothing seeded here (the database suite seeds as the owner)
  assert.deepEqual((await ws(A, 'GET', '/api/library')).body.items, [])
  assert.equal((await ws(A, 'GET', `/api/library/${randomUUID()}`)).status, 404)
  assert.equal((await ws(A, 'POST', '/api/library', { title: 'x' })).status, 405)

  // ---- deletes: a project delete detaches; a conversation delete cascades messages and saved items
  assert.equal((await ws(A, 'DELETE', `/api/projects/${p1.id}`)).status, 204)
  assert.equal((await ws(A, 'GET', `/api/projects/${p1.id}`)).status, 404)
  const detached = (await ws(A, 'GET', `/api/conversations/${conv.id}`)).body.conversation
  assert.equal(detached.projectId, null, 'the conversation survives the project delete, detached')
  assert.equal((await ws(A, 'GET', `/api/conversations/${conv.id}/messages`)).body.messages.length, 6)
  assert.equal((await ws(A, 'DELETE', `/api/conversations/${conv.id}`)).status, 204)
  assert.equal((await ws(A, 'GET', `/api/conversations/${conv.id}`)).status, 404)
  assert.equal((await ws(A, 'GET', `/api/conversations/${conv.id}/messages`)).status, 404)
  assert.equal((await ws(A, 'GET', '/api/saved')).body.items.length, 0, 'saved items of the deleted conversation are gone')
  assert.equal((await ws(A, 'DELETE', `/api/conversations/${conv.id}`)).status, 404)

  // ---- strictness reaches the real stack through the dispatcher: unknown keys, unknown query, bad ids
  assert.equal((await ws(A, 'POST', '/api/projects', { name: 'x', user_id: B.id })).status, 400)
  assert.equal((await ws(A, 'GET', '/api/projects?nope=1')).status, 400)
  assert.equal((await ws(A, 'GET', '/api/projects/not-a-uuid')).status, 400)
  assert.equal((await ws(A, 'GET', '/api/conversations?cursor=garbage')).status, 400)
  assert.equal((await ws(A, 'POST', '/api/conversations', { content: 'x', clientRequestId: newKey(), mentorId: 'not-in-catalog' })).status, 400)
})
