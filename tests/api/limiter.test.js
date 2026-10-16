import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryLimiter, limiterKey } from '../../api/_lib/limiter.js'

test('sliding window: allows max hits, blocks the next, frees up as old hits age out', () => {
  let t = 0
  const l = createMemoryLimiter({ now: () => t })
  const cfg = { max: 3, windowMs: 1000 }
  assert.deepEqual([l.hit('k', cfg).allowed, l.hit('k', cfg).allowed, l.hit('k', cfg).allowed], [true, true, true])
  const blocked = l.hit('k', cfg)
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterMs, 1000)
  t = 600
  assert.equal(l.hit('k', cfg).allowed, false)
  t = 1000 // the first hit (t=0) has aged out
  assert.equal(l.hit('k', cfg).allowed, true)
})

test('keys are independent and reset() clears one of them', () => {
  const l = createMemoryLimiter({ now: () => 0 })
  const cfg = { max: 1, windowMs: 1000 }
  assert.equal(l.hit('a', cfg).allowed, true)
  assert.equal(l.hit('a', cfg).allowed, false)
  assert.equal(l.hit('b', cfg).allowed, true)
  l.reset('a')
  assert.equal(l.hit('a', cfg).allowed, true)
})

test('blocked attempts are not recorded, so a lockout cannot be extended by hammering', () => {
  let t = 0
  const l = createMemoryLimiter({ now: () => t })
  const cfg = { max: 1, windowMs: 1000 }
  l.hit('k', cfg)
  for (t = 1; t < 900; t += 100) assert.equal(l.hit('k', cfg).allowed, false)
  t = 1000
  assert.equal(l.hit('k', cfg).allowed, true)
})

test('limiterKey hashes its input: no raw email or IP appears in a key', () => {
  const k = limiterKey('email', 'ada@example.com')
  assert.match(k, /^email:[0-9a-f]{64}$/)
  assert.ok(!k.includes('ada') && !k.includes('example'))
  assert.equal(limiterKey('email', 'a'), limiterKey('email', 'a'))
  assert.notEqual(limiterKey('email', 'a'), limiterKey('ip', 'a'))
})
