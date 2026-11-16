import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { toNode } from '../../api/_lib/node.js'
import { createSseSpikeRoute } from '../../api/_lib/sseSpike.js'

process.env.SSE_SPIKE_TOKEN = 'test-token'
delete process.env.VERCEL_ENV
const H = { 'x-spike-token': 'test-token' }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await wait(20); return fn() }

function serve(route, options) {
  const server = http.createServer(toNode(route, options))
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })))
}
const stop = (s) => { s.closeAllConnections(); s.close() }

// 1
test('LOCAL NODE: events arrive progressively, complete once, and are never classified as cancelled', async () => {
  const ev = [], ends = []
  const { server, base } = await serve(
    createSseSpikeRoute({ onEvent: (n) => ev.push(n) }),
    { onStreamEnd: (o) => ends.push(o) },
  )
  const t0 = Date.now(), at = []
  const res = await fetch(`${base}/api/library/spike-sse?seconds=2&tickMs=250`, { headers: H })
  for await (const _ of res.body) at.push(Date.now() - t0)
  await until(() => ends.length > 0, 1000)
  await wait(300) // let the 'close' event and any late cancellation surface before asserting
  assert.ok(at[0] < 400, `first chunk ${at[0]}ms`)
  assert.ok(at.at(-1) - at[0] >= 1500, 'chunks spread over time, not buffered')
  assert.ok(at.length >= 4, `chunks=${at.length}`)
  assert.deepEqual(ends.map((e) => e.outcome), ['completed'])
  assert.ok(ev.includes('completed'))
  assert.equal(ev.includes('stream_cancelled'), false, 'a completed stream must not be cancelled on close')
  assert.equal(ev.includes('abort_observed'), false, 'a completed stream must not abort the request signal')
  stop(server)
})

// 2
test('LOCAL NODE: a client disconnect propagates to request.signal and stops the work (not Vercel evidence)', async () => {
  const ev = [], ends = []
  const { server, base } = await serve(
    createSseSpikeRoute({ onEvent: (n) => ev.push({ n, at: Date.now() }) }),
    { onStreamEnd: (o) => ends.push(o) },
  )
  const ac = new AbortController()
  const res = await fetch(`${base}/api/library/spike-sse?seconds=20&tickMs=100`, { headers: H, signal: ac.signal })
  await res.body.getReader().read()
  const abortAt = Date.now()
  ac.abort()
  assert.ok(await until(() => ev.some((e) => e.n === 'abort_observed'), 3000), 'abort observed')
  assert.ok(ev.find((e) => e.n === 'abort_observed').at - abortAt <= 2000, 'observed within 2s')
  assert.ok(await until(() => ends.length > 0, 2000), 'adapter reported an outcome')
  const ticks = ev.filter((e) => e.n === 'tick').length
  await wait(500) // would be ~5 more ticks if work continued
  assert.equal(ev.filter((e) => e.n === 'tick').length, ticks, 'no work after cancellation')
  assert.ok(ev.some((e) => e.n === 'stream_cancelled'), 'reader was cancelled because the socket went away')
  assert.deepEqual(ends.map((e) => e.outcome), ['client_abort'])
  stop(server)
})

// 3
test('LOCAL NODE: a stream error is reported as error and the connection is not ended cleanly', async () => {
  const ends = []
  const route = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\n')); setTimeout(() => c.error(new TypeError('boom')), 50) },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
  const { server, base } = await serve(route, { onStreamEnd: (o) => ends.push(o) })
  const res = await fetch(`${base}/x`)
  let threw = false
  try { for await (const _ of res.body) { /* drain */ } } catch { threw = true }
  await until(() => ends.length > 0, 1000)
  stop(server)
  assert.equal(threw, true, 'client must see a failure, not a clean end')
  assert.deepEqual(ends, [{ outcome: 'error', errName: 'TypeError' }])
})

// 4
test('LOCAL NODE: JSON responses stay buffered and request.signal is not aborted after a normal response', async () => {
  let signal
  const route = async (request) => {
    signal = request.signal
    return new Response('{"ok":true}', { status: 201, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'a=b; Path=/' } })
  }
  const { server, base } = await serve(route)
  const res = await fetch(`${base}/x`)
  assert.equal(res.status, 201)
  assert.ok(res.headers.get('content-length'), 'buffered JSON keeps a content-length (not chunked streaming)')
  assert.deepEqual(await res.json(), { ok: true })
  assert.match(res.headers.get('set-cookie'), /a=b/)
  await wait(150)
  assert.equal(signal.aborted, false)
  stop(server)
})

// 5
test('spike route is 404 without the token (and with a wrong one)', async () => {
  const { server, base } = await serve(createSseSpikeRoute())
  assert.equal((await fetch(`${base}/api/library/spike-sse`)).status, 404)
  assert.equal((await fetch(`${base}/api/library/spike-sse`, { headers: { 'x-spike-token': 'nope' } })).status, 404)
  stop(server)
})

// 6
test('production gate: the spike is disabled in production even with a valid token, and with no configured token', async () => {
  const { server, base } = await serve(createSseSpikeRoute())
  try {
    process.env.VERCEL_ENV = 'production'
    assert.equal((await fetch(`${base}/api/library/spike-sse`, { headers: H })).status, 404)
    delete process.env.VERCEL_ENV
    const saved = process.env.SSE_SPIKE_TOKEN
    delete process.env.SSE_SPIKE_TOKEN
    assert.equal((await fetch(`${base}/api/library/spike-sse`, { headers: H })).status, 404)
    process.env.SSE_SPIKE_TOKEN = saved
    const ok = await fetch(`${base}/api/library/spike-sse?seconds=1&tickMs=100`, { headers: H })
    assert.equal(ok.status, 200)
    assert.match(ok.headers.get('content-type'), /^text\/event-stream/)
    await ok.body.cancel()
  } finally {
    process.env.SSE_SPIKE_TOKEN = 'test-token'
    delete process.env.VERCEL_ENV
    stop(server)
  }
})
