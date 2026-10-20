import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoute, MAX_BODY_BYTES } from '../../api/_lib/pipeline.js'
import { toNode } from '../../api/_lib/node.js'
import { limitParam, enumParam } from '../../api/_lib/params.js'
import { prodConfig, memoryLogger, makeRequest, json } from './helpers.js'

const ID = '3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b'

function build(options, fn) {
  const { logger, lines } = memoryLogger()
  const route = createRoute({ getConfig: () => prodConfig(), createSupabase: () => ({ supabase: {}, jar: null }), logger }, options, fn)
  return { route, lines }
}

test('the default body limit is unchanged for existing routes', async () => {
  const { route } = build({ methods: ['POST'], body: ['content'] }, async (ctx) => ({ body: { n: ctx.body.content.length } }))
  assert.equal(route.maxBodyBytes, MAX_BODY_BYTES)
  const ok = await route(makeRequest('/api/x', { body: { content: 'a'.repeat(100) } }))
  assert.equal(ok.status, 200)
  const tooBig = await route(makeRequest('/api/x', { body: { content: 'a'.repeat(MAX_BODY_BYTES) } }))
  assert.equal(tooBig.status, 413)
})

test('a route can raise its own body limit, and still enforces it', async () => {
  const { route } = build(
    { methods: ['POST'], body: ['content'], maxBodyBytes: 40960 },
    async (ctx) => ({ body: { n: ctx.body.content.length } }),
  )
  assert.equal(route.maxBodyBytes, 40960)
  const ok = await route(makeRequest('/api/x', { body: { content: 'a'.repeat(20000) } }))
  assert.equal(ok.status, 200)
  assert.equal((await json(ok)).n, 20000)
  const tooBig = await route(makeRequest('/api/x', { body: { content: 'a'.repeat(41000) } }))
  assert.equal(tooBig.status, 413)
  assert.equal((await json(tooBig)).error.code, 'payload_too_large')
})

test('status 204 sends no body', async () => {
  const { route } = build({ methods: ['DELETE'] }, async () => ({ status: 204 }))
  const res = await route(makeRequest('/api/x', { method: 'DELETE' }))
  assert.equal(res.status, 204)
  assert.equal(await res.text(), '')
  assert.equal(res.headers.get('cache-control').includes('no-store'), true)
})

test('path params and query are parsed strictly and exposed on ctx', async () => {
  const { route } = build(
    { methods: ['GET'], path: '/api/things/:id', query: { limit: limitParam(), status: enumParam(['a', 'b']) } },
    async (ctx) => ({ body: { params: ctx.params, query: ctx.query } }),
  )
  const ok = await route(makeRequest(`/api/things/${ID}?limit=5&status=b`, { method: 'GET' }))
  assert.equal(ok.status, 200)
  assert.deepEqual(await json(ok), { params: { id: ID }, query: { limit: 5, status: 'b' } })

  assert.equal((await route(makeRequest('/api/things/not-a-uuid', { method: 'GET' }))).status, 400)
  assert.equal((await route(makeRequest(`/api/things/${ID}?nope=1`, { method: 'GET' }))).status, 400)
  assert.equal((await route(makeRequest(`/api/things/${ID}?limit=1&limit=2`, { method: 'GET' }))).status, 400)
  assert.equal((await route(makeRequest('/api/other', { method: 'GET' }))).status, 404)
})

test('routes without options.query do not inspect the query string (A2/A3 behaviour)', async () => {
  const { route } = build({ methods: ['GET'] }, async (ctx) => ({ body: { query: ctx.query } }))
  const res = await route(makeRequest('/api/x?code=abc&anything=1', { method: 'GET' }))
  assert.equal(res.status, 200)
  assert.deepEqual((await json(res)).query, {})
})

test('toNode enforces the route-specific limit while streaming', async () => {
  const { route } = build({ methods: ['POST'], body: ['content'], maxBodyBytes: 8192 }, async () => ({ body: { ok: true } }))
  const handler = toNode(route)
  const run = async (size) => {
    const payload = Buffer.from(JSON.stringify({ content: 'a'.repeat(size) }))
    const req = (async function* () {
      yield payload
    })()
    req.method = 'POST'
    req.url = '/api/x'
    req.headers = { origin: 'https://app.example.com', 'x-ombre-request': '1', 'content-type': 'application/json' }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v
      },
      end(chunk) {
        this.body = chunk ? Buffer.from(chunk).toString('utf8') : ''
      },
    }
    await handler(req, res)
    return res
  }
  assert.equal((await run(5000)).statusCode, 200) // above the 4096 default, below the route limit
  assert.equal((await run(9000)).statusCode, 413)
})
