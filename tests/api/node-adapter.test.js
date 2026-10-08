import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { toNode } from '../../api/_lib/node.js'
import { MAX_BODY_BYTES } from '../../api/_lib/pipeline.js'

function serve(route) {
  const server = http.createServer(toNode(route))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

function raw(port, { method = 'POST', path = '/api/x', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('adapter passes method, path, headers, body and sends multiple Set-Cookie headers separately', async () => {
  let seen
  const { server, port } = await serve(async (request) => {
    seen = { method: request.method, path: new URL(request.url).pathname, origin: request.headers.get('origin'), cookie: request.headers.get('cookie'), body: await request.text() }
    const headers = new Headers({ 'Content-Type': 'application/json' })
    headers.append('Set-Cookie', 'a=1; Path=/; HttpOnly')
    headers.append('Set-Cookie', 'b=2; Path=/; HttpOnly')
    return new Response('{"ok":true}', { status: 201, headers })
  })
  try {
    const res = await raw(port, { headers: { origin: 'https://app.example.com', cookie: 'k=v', 'content-type': 'application/json' }, body: '{"x":1}' })
    assert.equal(res.status, 201)
    assert.deepEqual(res.headers['set-cookie'], ['a=1; Path=/; HttpOnly', 'b=2; Path=/; HttpOnly'])
    assert.deepEqual(seen, { method: 'POST', path: '/api/x', origin: 'https://app.example.com', cookie: 'k=v', body: '{"x":1}' })
    assert.equal(res.body, '{"ok":true}')
  } finally {
    server.close()
  }
})

test('adapter rejects oversized bodies with 413 before the route runs', async () => {
  let ran = false
  const { server, port } = await serve(async () => { ran = true; return new Response('{}') })
  try {
    const res = await raw(port, { headers: { 'content-type': 'application/json' }, body: 'x'.repeat(MAX_BODY_BYTES + 10) })
    assert.equal(res.status, 413)
    assert.equal(ran, false)
    assert.equal(JSON.parse(res.body).error.code, 'payload_too_large')
  } finally {
    server.close()
  }
})

test('adapter never trusts the Host header and returns generic 500 on route crashes', async () => {
  let url
  const { server, port } = await serve(async (request) => { url = request.url; throw new Error('secret failure') })
  try {
    const res = await raw(port, { method: 'GET', headers: { host: 'evil.example' } })
    assert.equal(res.status, 500)
    assert.ok(!res.body.includes('secret'))
    assert.ok(url.startsWith('http://internal.invalid/'))
  } finally {
    server.close()
  }
})

test('adapter: GET has no body and query strings survive', async () => {
  let seen
  const { server, port } = await serve(async (request) => { seen = new URL(request.url).search; return new Response('{}', { headers: { 'Content-Type': 'application/json' } }) })
  try {
    const res = await raw(port, { method: 'GET', path: '/api/auth/session?a=1' })
    assert.equal(res.status, 200)
    assert.equal(seen, '?a=1')
  } finally {
    server.close()
  }
})
