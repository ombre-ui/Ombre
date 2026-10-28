import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isUuid,
  parseUuid,
  matchPath,
  parseQuery,
  limitParam,
  enumParam,
  seqParam,
  cursorParam,
  encodeCursor,
  decodeCursor,
  keysetAfter,
  paginate,
} from '../../api/_lib/params.js'
import { ApiError } from '../../api/_lib/errors.js'

const ID = '3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b'
const ID2 = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const status = (fn) => {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof ApiError, 'expected an ApiError')
    return e.status
  }
  return null
}

test('UUIDs must be canonical lowercase', () => {
  assert.equal(isUuid(ID), true)
  assert.equal(isUuid(ID.toUpperCase()), false)
  assert.equal(isUuid(`${ID} `), false)
  assert.equal(isUuid('not-a-uuid'), false)
  assert.equal(isUuid('00000000-0000-0000-0000-000000000000'), false) // nil UUID has no version nibble 1-8
  assert.equal(isUuid(null), false)
  assert.equal(isUuid(['x']), false)
  assert.equal(status(() => parseUuid('1')), 400)
})

test('matchPath: captures UUID params, 404 for other shapes, 400 for bad ids', () => {
  assert.deepEqual(matchPath(`/api/projects/${ID}`, '/api/projects/:id'), { id: ID })
  assert.deepEqual(matchPath(`/api/conversations/${ID}/messages`, '/api/conversations/:id/messages'), { id: ID })
  assert.deepEqual(matchPath(`/api/projects/${ID}/`, '/api/projects/:id'), { id: ID }) // one trailing slash tolerated
  assert.deepEqual(matchPath('/api/projects', '/api/projects'), {})
  assert.equal(status(() => matchPath('/api/projects', '/api/projects/:id')), 404)
  assert.equal(status(() => matchPath(`/api/projects/${ID}/extra`, '/api/projects/:id')), 404)
  assert.equal(status(() => matchPath(`/api/other/${ID}`, '/api/projects/:id')), 404)
  assert.equal(status(() => matchPath('/api/projects/123', '/api/projects/:id')), 400)
  assert.equal(status(() => matchPath(`/api/projects/${ID.toUpperCase()}`, '/api/projects/:id')), 400)
  assert.equal(status(() => matchPath('/api/projects/%E0%A4%A', '/api/projects/:id')), 404) // malformed escape
  assert.equal(status(() => matchPath(`/api/projects/${ID}%2F..`, '/api/projects/:id')), 400)
})

test('parseQuery rejects unknown and repeated parameters', () => {
  const spec = { limit: limitParam(), status: enumParam(['active', 'archived']) }
  assert.deepEqual(parseQuery(new URL('http://x/a'), spec), {})
  assert.deepEqual(parseQuery(new URL('http://x/a?limit=5&status=archived'), spec), { limit: 5, status: 'archived' })
  assert.equal(status(() => parseQuery(new URL('http://x/a?other=1'), spec)), 400)
  assert.equal(status(() => parseQuery(new URL('http://x/a?limit=5&limit=6'), spec)), 400)
  assert.equal(status(() => parseQuery(new URL('http://x/a?status=ARCHIVED'), spec)), 400)
  assert.equal(status(() => parseQuery(new URL('http://x/a?__proto__=1'), spec)), 400)
  assert.equal(status(() => parseQuery(new URL('http://x/a?constructor=1'), spec)), 400)
})

test('limit: 1..50 integers only', () => {
  const parse = limitParam()
  assert.equal(parse('1'), 1)
  assert.equal(parse('50'), 50)
  for (const bad of ['0', '51', '-1', '01', '1.5', '', ' 5', '5 ', '1e1', '0x10', '99999']) {
    assert.equal(status(() => parse(bad)), 400, `limit ${JSON.stringify(bad)}`)
  }
})

test('seq: 0..500 integers only', () => {
  const parse = seqParam()
  assert.equal(parse('0'), 0)
  assert.equal(parse('500'), 500)
  for (const bad of ['501', '-1', '01', '1.5', '', 'abc']) assert.equal(status(() => parse(bad)), 400)
})

test('cursor round-trips and normalises +00:00 to Z', () => {
  const encoded = encodeCursor({ t: '2026-10-20T03:30:00.123456+00:00', i: ID })
  assert.match(encoded, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodeCursor(encoded), { t: '2026-10-20T03:30:00.123456Z', i: ID })
  assert.deepEqual(decodeCursor(encodeCursor({ t: '2026-10-20T03:30:00Z', i: ID })), { t: '2026-10-20T03:30:00Z', i: ID })
})

test('cursor rejects tampering of every kind', () => {
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8').toString('base64url')
  const good = { t: '2026-10-20T03:30:00Z', i: ID }
  const bad = [
    '',
    'a'.repeat(201),
    'not base64!',
    b64('not json'),
    b64('[]'),
    b64('null'),
    b64({ t: good.t }), // missing key
    b64({ ...good, extra: 1 }), // extra key
    b64({ t: 5, i: ID }), // wrong type
    b64({ t: good.t, i: 5 }),
    b64({ t: good.t, i: ID.toUpperCase() }),
    b64({ t: '2026-10-20 03:30:00Z', i: ID }), // not ISO T form
    b64({ t: '2026-10-20T03:30:00+05:00', i: ID }), // only UTC accepted
    b64({ t: '2026-13-45T03:30:00Z', i: ID }), // impossible date
    b64({ t: '2026-10-20T03:30:00Z),id.eq.x,or(a.eq.1', i: ID }), // filter injection attempt
    b64({ t: good.t, i: `${ID},id.neq.${ID2}` }),
  ]
  for (const raw of bad) assert.equal(status(() => decodeCursor(raw)), 400, `cursor ${raw.slice(0, 40)}`)
  assert.equal(status(() => cursorParam()('%%%')), 400)
})

test('keysetAfter builds a filter from validated parts only', () => {
  const cursor = decodeCursor(encodeCursor({ t: '2026-10-20T03:30:00.5Z', i: ID }))
  assert.equal(
    keysetAfter('last_message_at', cursor),
    `last_message_at.lt.2026-10-20T03:30:00.5Z,and(last_message_at.eq.2026-10-20T03:30:00.5Z,id.lt.${ID})`,
  )
})

test('paginate: next cursor only when there is another row', () => {
  const rows = [
    { id: ID, updated_at: '2026-10-20T03:30:03.000001+00:00' },
    { id: ID2, updated_at: '2026-10-20T03:30:02.000001+00:00' },
    { id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', updated_at: '2026-10-20T03:30:01.000001+00:00' },
  ]
  const exact = paginate(rows.slice(0, 2), 2, 'updated_at')
  assert.equal(exact.nextCursor, null)
  assert.equal(exact.page.length, 2)
  const more = paginate(rows, 2, 'updated_at')
  assert.equal(more.page.length, 2)
  assert.deepEqual(decodeCursor(more.nextCursor), { t: '2026-10-20T03:30:02.000001Z', i: ID2 })
})
