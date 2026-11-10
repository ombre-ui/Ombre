import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRequest, json } from './helpers.js'
import { decodeCursor, encodeCursor } from '../../api/_lib/params.js'
import {
  ID1,
  ID2,
  ID3,
  KEY1,
  USER,
  buildWorkspace,
  conversationRow,
  fail,
  messageRow,
  ok,
  opsOf,
  projectRow,
} from './workspace-helpers.js'

const GET = { method: 'GET' }
const sessionMissing = Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400 })

// ------------------------------------------------------------------ authentication

test('every workspace route answers 401 without a session', async () => {
  const { routes, calls } = buildWorkspace({ authError: sessionMissing, handler: () => ok([]) })
  const cases = [
    [routes.projectsIndex, '/api/projects', GET],
    [routes.projectById, `/api/projects/${ID1}`, GET],
    [routes.conversationsIndex, '/api/conversations', GET],
    [routes.conversationById, `/api/conversations/${ID1}`, GET],
    [routes.conversationMessages, `/api/conversations/${ID1}/messages`, GET],
    [routes.savedIndex, '/api/saved', GET],
    [routes.savedById, `/api/saved/${ID1}`, { method: 'DELETE' }],
    [routes.libraryIndex, '/api/library', GET],
    [routes.libraryById, `/api/library/${ID1}`, GET],
  ]
  for (const [route, path, opts] of cases) {
    const res = await route(makeRequest(path, opts))
    assert.equal(res.status, 401, path)
    assert.equal((await json(res)).error.code, 'unauthenticated')
  }
  assert.equal(calls.filter((c) => c.table).length, 0, 'no table query may run before authentication')
})

test('writes need the CSRF header and a same-origin Origin (inherited from the pipeline)', async () => {
  const { routes } = buildWorkspace({ handler: () => ok([projectRow()]) })
  const noHeader = await routes.projectsIndex(makeRequest('/api/projects', { body: { name: 'A' }, csrf: false }))
  assert.equal(noHeader.status, 403)
  const wrongOrigin = await routes.projectsIndex(makeRequest('/api/projects', { body: { name: 'A' }, origin: 'https://evil.example' }))
  assert.equal(wrongOrigin.status, 403)
})

// ---------------------------------------------------------------------- projects

test('POST /api/projects inserts only name and description and never returns user_id', async () => {
  const { routes, calls } = buildWorkspace({ handler: () => ok([projectRow({ name: 'Alpha', description: 'Notes' })]) })
  const res = await routes.projectsIndex(makeRequest('/api/projects', { body: { name: '  Alpha ', description: 'Notes' } }))
  assert.equal(res.status, 201)
  const body = await json(res)
  assert.deepEqual(Object.keys(body.project).sort(), ['archivedAt', 'createdAt', 'description', 'id', 'name', 'updatedAt'])
  const call = calls.find((c) => c.table === 'projects')
  assert.deepEqual(opsOf(call, 'insert')[0][1], { name: 'Alpha', description: 'Notes' })
})

test('project create rejects mass assignment, bad names and over-long input', async () => {
  const { routes, calls } = buildWorkspace({ handler: () => ok([projectRow()]) })
  const bad = [
    { name: 'A', user_id: ID1 },
    { name: 'A', userId: ID1 },
    { name: 'A', id: ID1 },
    { name: 'A', archived_at: '2026-01-01T00:00:00Z' },
    { name: 'A', created_at: '2026-01-01T00:00:00Z' },
    {},
    { name: '' },
    { name: '   ' },
    { name: 5 },
    { name: 'x'.repeat(101) },
    { name: 'multi\nline' },
    { name: 'tab\there' },
    { name: 'A', description: 'x'.repeat(2001) },
    { name: 'A', description: 'nul\u0000byte' },
    { name: 'lone\ud800surrogate' },
  ]
  for (const body of bad) {
    const res = await routes.projectsIndex(makeRequest('/api/projects', { body }))
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60))
  }
  assert.equal(calls.filter((c) => c.table).length, 0, 'invalid input must never reach the database')
  assert.equal((await routes.projectsIndex(makeRequest('/api/projects', { body: { name: 'x'.repeat(100) } }))).status, 201)
})

test('project create maps the per-user cap to 409 limit_reached', async () => {
  const { routes } = buildWorkspace({ handler: () => fail('OL001') })
  const res = await routes.projectsIndex(makeRequest('/api/projects', { body: { name: 'A' } }))
  assert.equal(res.status, 409)
  assert.equal((await json(res)).error.code, 'limit_reached')
})

test('GET /api/projects: owner filter, status filter, keyset cursor, and a next cursor', async () => {
  const rows = [
    projectRow({ id: ID1, updated_at: '2026-10-20T03:30:03.000001+00:00', conversations: [{ count: 2 }] }),
    projectRow({ id: ID2, updated_at: '2026-10-20T03:30:02.000001+00:00', conversations: [{ count: 0 }] }),
    projectRow({ id: ID3, updated_at: '2026-10-20T03:30:01.000001+00:00', conversations: [{ count: 1 }] }),
  ]
  const { routes, calls } = buildWorkspace({ handler: () => ok(rows) })
  const res = await routes.projectsIndex(makeRequest('/api/projects?limit=2', GET))
  assert.equal(res.status, 200)
  const body = await json(res)
  assert.equal(body.projects.length, 2)
  assert.equal(body.projects[0].conversationCount, 2)
  assert.deepEqual(decodeCursor(body.nextCursor), { t: '2026-10-20T03:30:02.000001Z', i: ID2 })

  const call = calls.find((c) => c.table === 'projects')
  assert.deepEqual(opsOf(call, 'eq')[0], ['eq', 'user_id', USER])
  assert.deepEqual(opsOf(call, 'is')[0], ['is', 'archived_at', null])
  assert.deepEqual(opsOf(call, 'limit')[0], ['limit', 3])

  const cursor = encodeCursor({ t: '2026-10-20T03:30:02.000001Z', i: ID2 })
  const next = buildWorkspace({ handler: () => ok([]) })
  await next.routes.projectsIndex(makeRequest(`/api/projects?status=archived&cursor=${cursor}`, GET))
  const nextCall = next.calls.find((c) => c.table === 'projects')
  assert.deepEqual(opsOf(nextCall, 'not')[0], ['not', 'archived_at', 'is', null])
  assert.equal(opsOf(nextCall, 'or')[0][1], `updated_at.lt.2026-10-20T03:30:02.000001Z,and(updated_at.eq.2026-10-20T03:30:02.000001Z,id.lt.${ID2})`)
})

test('project list rejects bad query input before touching the database', async () => {
  const { routes, calls } = buildWorkspace({ handler: () => ok([]) })
  for (const q of ['limit=0', 'limit=51', 'limit=x', 'status=all', 'cursor=bad', 'cursor=', 'other=1', 'limit=1&limit=2']) {
    assert.equal((await routes.projectsIndex(makeRequest(`/api/projects?${q}`, GET))).status, 400, q)
  }
  assert.equal(calls.filter((c) => c.table).length, 0)
})

test('project by id: strict ids, uniform 404, PATCH and DELETE semantics', async () => {
  const empty = buildWorkspace({ handler: () => ok([]) })
  assert.equal((await empty.routes.projectById(makeRequest('/api/projects/not-a-uuid', GET))).status, 400)
  assert.equal((await empty.routes.projectById(makeRequest(`/api/projects/${ID1.toUpperCase()}`, GET))).status, 400)
  const missing = await empty.routes.projectById(makeRequest(`/api/projects/${ID1}`, GET))
  const foreignLike = await empty.routes.projectById(makeRequest(`/api/projects/${ID2}`, GET))
  assert.equal(missing.status, 404)
  assert.equal(foreignLike.status, 404)
  const a = await json(missing)
  const b = await json(foreignLike)
  delete a.error.requestId
  delete b.error.requestId
  assert.deepEqual(a, b, 'foreign and nonexistent ids are indistinguishable')

  const patch = buildWorkspace({ handler: () => ok([projectRow({ archived_at: '2026-10-20T03:31:00.000001+00:00' })]) })
  const res = await patch.routes.projectById(makeRequest(`/api/projects/${ID1}`, { method: 'PATCH', body: { archived: true, name: ' New ' } }))
  assert.equal(res.status, 200)
  const call = patch.calls.find((c) => c.table === 'projects')
  const update = opsOf(call, 'update')[0][1]
  assert.deepEqual(Object.keys(update).sort(), ['archived_at', 'name'])
  assert.match(update.archived_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(update.name, 'New')
  assert.deepEqual(opsOf(call, 'eq').map((o) => o.slice(1)), [['id', ID1], ['user_id', USER]])

  const unarchive = buildWorkspace({ handler: () => ok([projectRow()]) })
  await unarchive.routes.projectById(makeRequest(`/api/projects/${ID1}`, { method: 'PATCH', body: { archived: false } }))
  assert.equal(opsOf(unarchive.calls[0], 'update')[0][1].archived_at, null)

  for (const body of [{}, { archived: 'yes' }, { user_id: ID1 }, { archivedAt: 'x' }, { id: ID2 }]) {
    assert.equal((await patch.routes.projectById(makeRequest(`/api/projects/${ID1}`, { method: 'PATCH', body }))).status, 400)
  }

  const del = buildWorkspace({ handler: () => ok([{ id: ID1 }]) })
  const deleted = await del.routes.projectById(makeRequest(`/api/projects/${ID1}`, { method: 'DELETE' }))
  assert.equal(deleted.status, 204)
  assert.equal(await deleted.text(), '')
  const gone = await empty.routes.projectById(makeRequest(`/api/projects/${ID1}`, { method: 'DELETE' }))
  assert.equal(gone.status, 404)
})

// ----------------------------------------------------------------- conversations

const created = () => ({
  conversation: conversationRow({ title: 'Hello there', message_count: 1 }),
  message: messageRow(),
})

test('POST /api/conversations calls the atomic function with validated, derived arguments', async () => {
  const { routes, calls } = buildWorkspace({ handler: () => ok(created()) })
  const res = await routes.conversationsIndex(
    makeRequest('/api/conversations', {
      body: { content: 'Hello there\nsecond line', clientRequestId: KEY1, mentorId: 'bug-hunter', projectId: ID3 },
    }),
  )
  assert.equal(res.status, 201)
  const body = await json(res)
  assert.equal(body.conversation.messageCount, 1)
  assert.equal(body.message.demo, false)
  assert.equal(body.message.status, 'complete')
  assert.deepEqual(body.message.attachments, [])
  const rpc = calls.find((c) => c.rpc)
  assert.equal(rpc.rpc, 'create_conversation')
  assert.deepEqual(rpc.args, {
    p_title: 'Hello there second line',
    p_mentor_id: 'bug-hunter',
    p_project_id: ID3,
    p_content: 'Hello there\nsecond line',
    p_client_request_id: KEY1,
  })
})

test('conversation create: General AI defaults, catalog validation and mass assignment', async () => {
  const { routes, calls } = buildWorkspace({ handler: () => ok(created()) })
  await routes.conversationsIndex(makeRequest('/api/conversations', { body: { content: 'Hi', clientRequestId: KEY1 } }))
  assert.deepEqual(
    [calls[0].args.p_mentor_id, calls[0].args.p_project_id, calls[0].args.p_title],
    [null, null, 'Hi'],
  )
  const bad = [
    { content: 'Hi' }, // no idempotency key
    { clientRequestId: KEY1 },
    { content: 'Hi', clientRequestId: 'nope' },
    { content: 'Hi', clientRequestId: KEY1, mentorId: 'not-in-catalog' },
    { content: 'Hi', clientRequestId: KEY1, mentorId: 'BUG-HUNTER' },
    { content: 'Hi', clientRequestId: KEY1, mentorId: 5 },
    { content: 'Hi', clientRequestId: KEY1, projectId: 'x' },
    { content: 'Hi', clientRequestId: KEY1, user_id: ID1 },
    { content: 'Hi', clientRequestId: KEY1, title: 'Chosen by client' },
    { content: 'Hi', clientRequestId: KEY1, messageCount: 0 },
    { content: 'Hi', clientRequestId: KEY1, role: 'assistant' },
    { content: 'Hi', clientRequestId: KEY1, isDemo: false },
    { content: '   ', clientRequestId: KEY1 },
    { content: 'x'.repeat(8001), clientRequestId: KEY1 },
  ]
  const before = calls.length
  for (const body of bad) {
    assert.equal((await routes.conversationsIndex(makeRequest('/api/conversations', { body }))).status, 400, JSON.stringify(body).slice(0, 70))
  }
  assert.equal(calls.length, before, 'invalid input must never reach the database')
})

test('conversation create: body limit is 40 KB and still enforced', async () => {
  const { routes } = buildWorkspace({ handler: () => ok(created()) })
  const big = 'a'.repeat(8000) // exactly the character limit
  assert.equal((await routes.conversationsIndex(makeRequest('/api/conversations', { body: { content: big, clientRequestId: KEY1 } }))).status, 201)
  const huge = await routes.conversationsIndex(makeRequest('/api/conversations', { body: { content: 'a'.repeat(50000), clientRequestId: KEY1 } }))
  assert.equal(huge.status, 413)
})

test('conversation create maps database refusals: foreign project, history off, caps', async () => {
  const run = async (result) => {
    const { routes } = buildWorkspace({ handler: () => result })
    const res = await routes.conversationsIndex(makeRequest('/api/conversations', { body: { content: 'Hi', clientRequestId: KEY1, projectId: ID3 } }))
    return [res.status, (await json(res)).error.code]
  }
  assert.deepEqual(await run(fail('23503')), [404, 'not_found'])
  assert.deepEqual(await run(fail('42501')), [409, 'history_disabled'])
  assert.deepEqual(await run(fail('OL001')), [409, 'limit_reached'])
  assert.deepEqual(await run(fail('23514')), [400, 'invalid_request'])
  assert.deepEqual(await run(fail('XX000', 500)), [503, 'service_unavailable'])
  assert.deepEqual(await run(fail('XX000', 400)), [500, 'internal_error'])
})

test('a replayed conversation create returns the original; a different payload is a conflict', async () => {
  const handler = (payload) => {
    if (payload.rpc) return fail('23505', 409)
    if (payload.table === 'messages') return ok([messageRow({ seq: 1, content: 'Hi' })])
    return ok([conversationRow({ id: ID1 })])
  }
  const { routes } = buildWorkspace({ handler })
  const same = await routes.conversationsIndex(makeRequest('/api/conversations', { body: { content: 'Hi', clientRequestId: KEY1 } }))
  assert.equal(same.status, 200)
  assert.equal((await json(same)).message.seq, 1)
  const different = await routes.conversationsIndex(makeRequest('/api/conversations', { body: { content: 'Other', clientRequestId: KEY1 } }))
  assert.equal(different.status, 409)
  assert.equal((await json(different)).error.code, 'conflict')
  const otherMentor = await routes.conversationsIndex(makeRequest('/api/conversations', { body: { content: 'Hi', clientRequestId: KEY1, mentorId: 'bug-hunter' } }))
  assert.equal(otherMentor.status, 409)
})

test('GET /api/conversations filters by owner and project, orders by last message, pages by cursor', async () => {
  const rows = [
    conversationRow({ id: ID1, last_message_at: '2026-10-20T03:30:03.000001+00:00' }),
    conversationRow({ id: ID2, last_message_at: '2026-10-20T03:30:02.000001+00:00' }),
  ]
  const { routes, calls } = buildWorkspace({ handler: () => ok(rows) })
  const res = await routes.conversationsIndex(makeRequest(`/api/conversations?projectId=${ID3}&limit=1`, GET))
  const body = await json(res)
  assert.equal(body.conversations.length, 1)
  assert.deepEqual(decodeCursor(body.nextCursor), { t: '2026-10-20T03:30:03.000001Z', i: ID1 })
  const call = calls.find((c) => c.table === 'conversations')
  assert.deepEqual(opsOf(call, 'eq').map((o) => o.slice(1)), [['user_id', USER], ['project_id', ID3]])
  assert.deepEqual(opsOf(call, 'order').map((o) => o[1]), ['last_message_at', 'id'])
  assert.equal((await routes.conversationsIndex(makeRequest('/api/conversations?projectId=nope', GET))).status, 400)
})

test('conversation by id: PATCH only title/projectId, DELETE is a 204 cascade, 404 for unknown', async () => {
  const patch = buildWorkspace({ handler: () => ok([conversationRow({ project_id: ID3 })]) })
  const res = await patch.routes.conversationById(makeRequest(`/api/conversations/${ID1}`, { method: 'PATCH', body: { projectId: ID3, title: ' Renamed ' } }))
  assert.equal(res.status, 200)
  assert.deepEqual(opsOf(patch.calls[0], 'update')[0][1], { project_id: ID3, title: 'Renamed' })
  await patch.routes.conversationById(makeRequest(`/api/conversations/${ID1}`, { method: 'PATCH', body: { projectId: null } }))
  assert.deepEqual(opsOf(patch.calls[1], 'update')[0][1], { project_id: null })
  for (const body of [{}, { title: '' }, { title: 'x'.repeat(121) }, { projectId: 'x' }, { message_count: 0 }, { messageCount: 0 }, { mentorId: 'bug-hunter' }, { user_id: ID1 }, { last_message_at: 'x' }]) {
    assert.equal((await patch.routes.conversationById(makeRequest(`/api/conversations/${ID1}`, { method: 'PATCH', body }))).status, 400, JSON.stringify(body))
  }
  const foreignProject = buildWorkspace({ handler: () => fail('23503', 409) })
  assert.equal((await foreignProject.routes.conversationById(makeRequest(`/api/conversations/${ID1}`, { method: 'PATCH', body: { projectId: ID3 } }))).status, 404)

  const del = buildWorkspace({ handler: () => ok([{ id: ID1 }]) })
  assert.equal((await del.routes.conversationById(makeRequest(`/api/conversations/${ID1}`, { method: 'DELETE' }))).status, 204)
  const none = buildWorkspace({ handler: () => ok([]) })
  assert.equal((await none.routes.conversationById(makeRequest(`/api/conversations/${ID1}`, { method: 'DELETE' }))).status, 404)
  assert.equal((await none.routes.conversationById(makeRequest(`/api/conversations/${ID1}`, GET))).status, 404)
})

// ----------------------------------------------------------------------- messages

test('POST message: isDemo is derived from the role and never read from the request', async () => {
  for (const [role, isDemo] of [['user', false], ['assistant', true]]) {
    const { routes, calls } = buildWorkspace({ handler: () => ok([messageRow({ role, is_demo: isDemo, seq: 2 })]) })
    const res = await routes.conversationMessages(
      makeRequest(`/api/conversations/${ID1}/messages`, { body: { role, content: 'Hello', clientRequestId: KEY1 } }),
    )
    assert.equal(res.status, 201)
    assert.equal((await json(res)).message.demo, isDemo)
    assert.deepEqual(opsOf(calls[0], 'insert')[0][1], {
      conversation_id: ID1,
      role,
      content: 'Hello',
      is_demo: isDemo,
      client_request_id: KEY1,
    })
  }
})

test('POST message rejects every attempt to set demo status, ids, sequence or ownership', async () => {
  const { routes, calls } = buildWorkspace({ handler: () => ok([messageRow()]) })
  const base = { role: 'assistant', content: 'Hi', clientRequestId: KEY1 }
  const bad = [
    { ...base, isDemo: false },
    { ...base, is_demo: false },
    { ...base, demo: false },
    { ...base, seq: 99 },
    { ...base, id: ID2 },
    { ...base, user_id: ID1 },
    { ...base, conversation_id: ID2 },
    { ...base, status: 'complete' },
    { ...base, created_at: '2020-01-01T00:00:00Z' },
    { ...base, role: 'system' },
    { ...base, role: 'ASSISTANT' },
    { ...base, role: undefined },
    { role: 'user', content: 'Hi' }, // no idempotency key
    { ...base, clientRequestId: 'x' },
    { ...base, content: '' },
    { ...base, content: ' \n\t' },
    { ...base, content: 5 },
    { ...base, content: 'x'.repeat(8001) },
    { ...base, content: 'has\u0000nul' },
    { ...base, content: 'lone\ud83dsurrogate' },
  ]
  for (const body of bad) {
    const res = await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages`, { body }))
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80))
  }
  assert.equal(calls.filter((c) => c.table).length, 0, 'invalid input must never reach the database')
  const exact = await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages`, { body: { ...base, content: 'x'.repeat(8000) } }))
  assert.equal(exact.status, 201)
  const emoji = await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages`, { body: { ...base, content: '\u{1F600}'.repeat(8000) } }))
  assert.equal(emoji.status, 201, 'the limit counts characters (code points), like char_length')
  assert.equal((await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages`, { body: { ...base, content: '\u{1F600}'.repeat(8001) } }))).status, 400)
})

test('POST message maps refusals: unknown conversation, history off, 500-message cap', async () => {
  const run = async (result) => {
    const { routes } = buildWorkspace({ handler: () => result })
    const res = await routes.conversationMessages(
      makeRequest(`/api/conversations/${ID1}/messages`, { body: { role: 'user', content: 'Hi', clientRequestId: KEY1 } }),
    )
    return [res.status, (await json(res)).error.code]
  }
  assert.deepEqual(await run(fail('23503', 409)), [404, 'not_found'])
  assert.deepEqual(await run(fail('42501', 403)), [409, 'history_disabled'])
  assert.deepEqual(await run(fail('OL001')), [409, 'limit_reached'])
})

test('POST message replay: same payload is idempotent, anything else is a conflict', async () => {
  const handler = (payload) => (payload.ops.some((o) => o[0] === 'insert') ? fail('23505', 409) : ok([messageRow({ content: 'Hi', role: 'user' })]))
  const { routes } = buildWorkspace({ handler })
  const url = `/api/conversations/${ID1}/messages`
  assert.equal((await routes.conversationMessages(makeRequest(url, { body: { role: 'user', content: 'Hi', clientRequestId: KEY1 } }))).status, 200)
  assert.equal((await routes.conversationMessages(makeRequest(url, { body: { role: 'user', content: 'Changed', clientRequestId: KEY1 } }))).status, 409)
  assert.equal((await routes.conversationMessages(makeRequest(url, { body: { role: 'assistant', content: 'Hi', clientRequestId: KEY1 } }))).status, 409)
  const otherConversation = await routes.conversationMessages(makeRequest(`/api/conversations/${ID3}/messages`, { body: { role: 'user', content: 'Hi', clientRequestId: KEY1 } }))
  assert.equal(otherConversation.status, 409)
})

test('messages are append-only: the route exposes no update or delete', async () => {
  const { routes, calls } = buildWorkspace({ handler: () => ok([messageRow()]) })
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const res = await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages`, { method, body: method === 'DELETE' ? undefined : { content: 'x' } }))
    assert.equal(res.status, 405, method)
    assert.match(res.headers.get('allow'), /GET, POST/)
  }
  assert.equal(calls.length, 0)
  // There is no per-message path at all.
  assert.equal((await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages/${ID2}`, GET))).status, 404)
})

test('GET messages: one embedded query, ascending by seq, 404 for unknown conversation, cursor is the last seq', async () => {
  const messages = [1, 2, 3].map((seq) => messageRow({ id: [ID1, ID2, ID3][seq - 1], seq }))
  const { routes, calls } = buildWorkspace({ handler: () => ok([{ id: ID1, messages }]) })
  const res = await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages?limit=2&after=0`, GET))
  const body = await json(res)
  assert.deepEqual(body.messages.map((m) => m.seq), [1, 2])
  assert.equal(body.nextCursor, 2)
  assert.equal(calls.length, 1, 'one round trip')
  const call = calls[0]
  assert.deepEqual(opsOf(call, 'gt')[0], ['gt', 'messages.seq', 0])
  assert.deepEqual(opsOf(call, 'order')[0], ['order', 'seq', { referencedTable: 'messages', ascending: true }])
  assert.deepEqual(opsOf(call, 'limit')[0], ['limit', 3, { referencedTable: 'messages' }])
  assert.deepEqual(opsOf(call, 'eq').map((o) => o.slice(1)), [['id', ID1], ['user_id', USER]])

  const last = buildWorkspace({ handler: () => ok([{ id: ID1, messages: messages.slice(0, 2) }]) })
  assert.equal((await json(await last.routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages?limit=2`, GET)))).nextCursor, null)

  const unknown = buildWorkspace({ handler: () => ok([]) })
  assert.equal((await unknown.routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages`, GET))).status, 404)
  for (const q of ['limit=101', 'after=501', 'after=-1', 'after=x', 'cursor=abc']) {
    assert.equal((await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages?${q}`, GET))).status, 400, q)
  }
})

test('stored content that looks like script is returned as inert JSON text', async () => {
  const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>'
  const { routes } = buildWorkspace({ handler: () => ok([{ id: ID1, messages: [messageRow({ content: payload })] }]) })
  const res = await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages`, GET))
  assert.match(res.headers.get('content-type'), /^application\/json/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await json(res)).messages[0].content, payload)
})

// --------------------------------------------------------------------------- saved

test('saved items: create, idempotent duplicate, refusals, delete, no update', async () => {
  const create = buildWorkspace({ handler: () => ok([{ id: ID1, conversation_id: ID2, message_id: null, created_at: '2026-10-20T03:30:00.000001+00:00' }]) })
  const res = await create.routes.savedIndex(makeRequest('/api/saved', { body: { conversationId: ID2 } }))
  assert.equal(res.status, 201)
  assert.deepEqual(opsOf(create.calls[0], 'insert')[0][1], { conversation_id: ID2, message_id: null })

  const dup = buildWorkspace({ handler: (p) => (p.ops.some((o) => o[0] === 'insert') ? fail('23505', 409) : ok([{ id: ID1, conversation_id: ID2, message_id: ID3, created_at: '2026-10-20T03:30:00.000001+00:00' }])) })
  const replay = await dup.routes.savedIndex(makeRequest('/api/saved', { body: { conversationId: ID2, messageId: ID3 } }))
  assert.equal(replay.status, 200)
  assert.deepEqual(opsOf(dup.calls[1], 'eq').map((o) => o.slice(1)), [['user_id', USER], ['conversation_id', ID2], ['message_id', ID3]])
  await dup.routes.savedIndex(makeRequest('/api/saved', { body: { conversationId: ID2 } }))
  assert.deepEqual(opsOf(dup.calls[3], 'is')[0], ['is', 'message_id', null])

  for (const body of [{}, { conversationId: 'x' }, { conversationId: ID2, messageId: 'x' }, { conversationId: ID2, user_id: ID1 }, { conversationId: ID2, id: ID1 }]) {
    assert.equal((await create.routes.savedIndex(makeRequest('/api/saved', { body }))).status, 400)
  }
  const foreign = buildWorkspace({ handler: () => fail('23503', 409) })
  assert.equal((await foreign.routes.savedIndex(makeRequest('/api/saved', { body: { conversationId: ID2 } }))).status, 404)
  const cap = buildWorkspace({ handler: () => fail('OL001') })
  assert.equal((await cap.routes.savedIndex(makeRequest('/api/saved', { body: { conversationId: ID2 } }))).status, 409)

  const del = buildWorkspace({ handler: () => ok([{ id: ID1 }]) })
  assert.equal((await del.routes.savedById(makeRequest(`/api/saved/${ID1}`, { method: 'DELETE' }))).status, 204)
  assert.equal((await del.routes.savedById(makeRequest(`/api/saved/${ID1}`, { method: 'PATCH', body: {} }))).status, 405)
  const none = buildWorkspace({ handler: () => ok([]) })
  assert.equal((await none.routes.savedById(makeRequest(`/api/saved/${ID1}`, { method: 'DELETE' }))).status, 404)
})

// ------------------------------------------------------------------------- library

test('library is read-only and returns the frontend LibraryItem shape', async () => {
  const row = { id: ID1, project_id: null, source: 'ombre', kind: 'note', title: 'T', preview: 'P', created_at: '2026-10-20T03:30:00.000001+00:00', user_id: USER }
  const { routes, calls } = buildWorkspace({ handler: () => ok([row]) })
  const list = await routes.libraryIndex(makeRequest('/api/library?source=ombre', GET))
  assert.deepEqual((await json(list)).items[0], { id: ID1, title: 'T', source: 'ombre', kind: 'note', preview: 'P', projectId: null, createdAt: row.created_at })
  assert.deepEqual(opsOf(calls[0], 'eq').map((o) => o.slice(1)), [['user_id', USER], ['source', 'ombre']])
  assert.equal((await routes.libraryIndex(makeRequest('/api/library?source=other', GET))).status, 400)
  assert.equal((await routes.libraryById(makeRequest(`/api/library/${ID1}`, GET))).status, 200)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await routes.libraryIndex(makeRequest('/api/library', { method, body: method === 'DELETE' ? undefined : {} }))).status, 405, method)
    assert.equal((await routes.libraryById(makeRequest(`/api/library/${ID1}`, { method, body: method === 'DELETE' ? undefined : {} }))).status, 405, method)
  }
  const none = buildWorkspace({ handler: () => ok([]) })
  assert.equal((await none.routes.libraryById(makeRequest(`/api/library/${ID1}`, GET))).status, 404)
})

// ------------------------------------------------------------------------- logging

test('message content and database error text never reach the logs', async () => {
  const SECRET = 'SECRET-CONTENT-4f1c'
  const body = { role: 'user', content: SECRET, clientRequestId: KEY1 }
  for (const result of [ok([messageRow({ content: SECRET })]), fail('XX000', 500), fail('XX000', 400), fail('23514'), fail('42501', 403), fail('OL001')]) {
    const { routes, lines } = buildWorkspace({ handler: () => result })
    await routes.conversationMessages(makeRequest(`/api/conversations/${ID1}/messages`, { body }))
    const all = lines.join('\n')
    assert.equal(all.includes(SECRET), false, 'message content must not be logged')
    assert.equal(all.includes('SECRET-DB-DETAIL'), false, 'database error text must not be logged')
  }
  const create = buildWorkspace({ handler: () => fail('XX000', 400) })
  await create.routes.conversationsIndex(makeRequest('/api/conversations', { body: { content: SECRET, clientRequestId: KEY1 } }))
  assert.equal(create.lines.join('\n').includes(SECRET), false)
})
