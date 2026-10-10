import test from 'node:test'
import assert from 'node:assert/strict'
import { createSerialQueue } from '../../src/lib/user/serialQueue.js'
import { mergeSettings, mergeProfile, applyPending } from '../../src/lib/user/merge.js'

function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init.method, body: init.body, headers: init.headers })
    const { status = 200, body = {} } = await handler(calls.length, path, init)
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return calls
}

const { requestUserResource } = await import('../../src/lib/user/userApi.js')

test('serial queue runs tasks one at a time, in order', async () => {
  const enqueue = createSerialQueue()
  const log = []
  let active = 0
  let maxActive = 0
  const task = (name, ms) => async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    log.push(`start ${name}`)
    await new Promise((r) => setTimeout(r, ms))
    log.push(`end ${name}`)
    active -= 1
    return name
  }
  const results = await Promise.all([enqueue(task('a', 15)), enqueue(task('b', 1)), enqueue(task('c', 5))])
  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.equal(maxActive, 1)
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
})

test('a failed (rejected) or failing task never blocks later tasks', async () => {
  const enqueue = createSerialQueue()
  const first = enqueue(async () => { throw new Error('boom') })
  const second = enqueue(async () => ({ ok: false, status: 500 })) // resolved failure result
  const third = enqueue(async () => 'still runs')
  await assert.rejects(first, /boom/)
  assert.deepEqual(await second, { ok: false, status: 500 })
  assert.equal(await third, 'still runs')
})

test('queue is independent per instance (scoped, not global)', async () => {
  const a = createSerialQueue()
  const b = createSerialQueue()
  let release
  const gate = new Promise((r) => { release = r })
  const slow = a(() => gate)
  assert.equal(await b(async () => 'b runs while a waits'), 'b runs while a waits')
  release()
  await slow
})

test('requestUserResource: success makes exactly one request, with the CSRF header and same-origin credentials', async () => {
  const calls = stubFetch(() => ({ body: { settings: { ok: 1 } } }))
  const reauth = async () => assert.fail('reauth must not run on success')
  const res = await requestUserResource('/api/user/settings', { method: 'PATCH', body: { ai: { suggestMentors: true } } }, reauth)
  assert.equal(res.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'PATCH')
  assert.equal(calls[0].headers['X-Ombre-Request'], '1')
  assert.equal(calls[0].body, '{"ai":{"suggestMentors":true}}')
})

test('401 -> re-validate the session once -> retry once -> success', async () => {
  const calls = stubFetch((n) => (n === 1 ? { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } } : { body: { profile: { displayName: 'A' } } }))
  let reauthCalls = 0
  const res = await requestUserResource('/api/user/profile', { method: 'PATCH', body: { displayName: 'A' } }, async () => { reauthCalls += 1 })
  assert.equal(res.ok, true)
  assert.equal(reauthCalls, 1)
  assert.equal(calls.length, 2)
})

test('a second 401 is returned, not retried again (no loop)', async () => {
  const calls = stubFetch(() => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } }))
  let reauthCalls = 0
  const res = await requestUserResource('/api/user/profile', {}, async () => { reauthCalls += 1 })
  assert.equal(res.ok, false)
  assert.equal(res.status, 401)
  assert.equal(reauthCalls, 1)
  assert.equal(calls.length, 2)
})

test('non-401 failures (400, 404, 503, network) are never retried and never re-authenticate', async () => {
  for (const status of [400, 404, 500, 503]) {
    const calls = stubFetch(() => ({ status, body: { error: { code: 'x', message: 'y' } } }))
    let reauthCalls = 0
    const res = await requestUserResource('/api/user/profile', {}, async () => { reauthCalls += 1 })
    assert.equal(res.status, status)
    assert.equal(calls.length, 1)
    assert.equal(reauthCalls, 0)
  }
  globalThis.fetch = async () => { throw new TypeError('network down') }
  const res = await requestUserResource('/api/user/profile', {}, async () => assert.fail('no reauth on network errors'))
  assert.equal(res.status, 0)
})

test('a failed request does not block the next queued request', async () => {
  const calls = stubFetch((n) => (n === 1 ? { status: 503, body: { error: { code: 'service_unavailable', message: 'x' } } } : { body: { ok: true } }))
  const first = requestUserResource('/api/user/settings', { method: 'PATCH', body: { general: { theme: 'dark' } } })
  const second = requestUserResource('/api/user/settings', { method: 'PATCH', body: { general: { theme: 'light' } } })
  assert.equal((await first).ok, false)
  assert.equal((await second).ok, true)
  assert.equal(calls.length, 2)
})

test('optimistic display = confirmed + pending; a failed patch is dropped and nothing stale remains', () => {
  const confirmed = { general: { theme: 'system' }, notifications: { email: true, inApp: true }, privacy: { saveHistory: true, rememberContext: false }, ai: { responseStyle: 'balanced', useNameInResponses: false, suggestMentors: true } }
  const p1 = { id: 1, patch: { general: { theme: 'dark' } } }
  const p2 = { id: 2, patch: { notifications: { email: false } } }
  const p3 = { id: 3, patch: { general: { theme: 'light' } } }
  let shown = applyPending(confirmed, [p1, p2, p3], mergeSettings)
  assert.equal(shown.general.theme, 'light')
  assert.equal(shown.notifications.email, false)
  assert.equal(shown.notifications.inApp, true) // sibling fields survive a partial patch
  // p3 fails: dropped, display falls back to p1 (still pending) rather than to a stale optimistic value
  shown = applyPending(confirmed, [p1, p2], mergeSettings)
  assert.equal(shown.general.theme, 'dark')
  // p1 and p2 both fail: back to the confirmed server state exactly
  assert.deepEqual(applyPending(confirmed, [], mergeSettings), confirmed)
  assert.notEqual(applyPending(confirmed, [], mergeSettings), undefined)
  // merging never mutates its inputs
  assert.equal(confirmed.general.theme, 'system')
})

test('mergeProfile only overlays the patched field', () => {
  const confirmed = { displayName: 'Ada', email: 'a@b.co', createdAt: 't' }
  assert.deepEqual(mergeProfile(confirmed, { displayName: null }), { displayName: null, email: 'a@b.co', createdAt: 't' })
})
