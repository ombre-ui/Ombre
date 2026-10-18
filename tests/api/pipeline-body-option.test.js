import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoute } from '../../api/_lib/pipeline.js'
import { prodConfig, makeRequest, memoryLogger, json } from './helpers.js'

function mk(options, fn = async (ctx) => ({ body: { got: ctx.body ?? null } })) {
  const { logger } = memoryLogger()
  return createRoute({ getConfig: () => prodConfig(), createSupabase: () => { throw new Error('no supabase') }, logger }, options, fn)
}

const get = () => makeRequest('/api/x', { method: 'GET', csrf: false, origin: undefined })

test('object form: the GET carries no body and needs no content-type', async () => {
  const route = mk({ methods: ['GET', 'PATCH'], body: { PATCH: ['a'] } })
  const res = await route(get())
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { got: null })
})

test('object form: PATCH requires JSON, parses with the PATCH keys and rejects unknown keys', async () => {
  const route = mk({ methods: ['GET', 'PATCH'], body: { PATCH: ['a'] } })
  const ok = await route(makeRequest('/api/x', { method: 'PATCH', body: { a: 1 } }))
  assert.deepEqual(await json(ok), { got: { a: 1 } })
  assert.equal((await route(makeRequest('/api/x', { method: 'PATCH', body: { b: 1 } }))).status, 400)
  const textReq = new Request('http://internal.invalid/api/x', { method: 'PATCH', headers: { origin: 'https://app.example.com', 'x-ombre-request': '1', 'content-type': 'text/plain' }, body: 'a=1' })
  assert.equal((await route(textReq)).status, 415)
})

test('object form: a method without an entry ignores its body but still enforces the size limit and CSRF', async () => {
  const route = mk({ methods: ['POST', 'PATCH'], body: { PATCH: ['a'] } })
  assert.equal((await route(makeRequest('/api/x', { method: 'POST', body: { z: 1 } }))).status, 200)
  assert.equal((await route(makeRequest('/api/x', { method: 'POST', body: 'x'.repeat(5000) }))).status, 413)
  assert.equal((await route(makeRequest('/api/x', { method: 'POST', body: { z: 1 }, csrf: false }))).status, 403)
})

test('array form is unchanged: every method needs JSON, so a GET without content-type is 415', async () => {
  const route = mk({ methods: ['GET', 'POST'], body: ['a'] })
  assert.equal((await route(get())).status, 415)
  assert.equal((await route(makeRequest('/api/x', { body: { a: 1 } }))).status, 200)
  assert.equal((await route(makeRequest('/api/x', { body: { b: 1 } }))).status, 400)
})

test('null and omitted body options are unchanged', async () => {
  for (const options of [{ methods: ['POST'], body: null }, { methods: ['POST'] }]) {
    const route = mk(options)
    assert.equal((await route(makeRequest('/api/x'))).status, 200)
    assert.equal((await route(makeRequest('/api/x', { body: 'x'.repeat(5000) }))).status, 413)
  }
})
