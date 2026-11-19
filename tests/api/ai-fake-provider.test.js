import test from 'node:test'
import assert from 'node:assert/strict'
import { AiProviderError, PROVIDER_ERROR_KINDS } from '../../api/_lib/ai/provider.js'
import { FAKE_OVERSIZE_DEFAULT, FAKE_PROVIDER_ID, FAKE_REPLY_PREFIX, createFakeProvider } from '../../api/_lib/ai/providers/fake.js'

const request = (over = {}) => ({
  system: 'SYSTEM PROMPT',
  messages: [{ role: 'user', content: 'What should I build first?' }],
  model: 'fake-model',
  maxOutputTokens: 1500,
  signal: new AbortController().signal,
  ...over,
})
const codePoints = (s) => Array.from(s).length

test('the fake provider is clearly test-only', async () => {
  assert.equal(FAKE_PROVIDER_ID, 'fake')
  assert.match(FAKE_REPLY_PREFIX, /FAKE PROVIDER - TEST ONLY/)
  const provider = createFakeProvider()
  assert.equal(provider.id, 'fake')
  const result = await provider.generate(request())
  assert.ok(result.text.startsWith(FAKE_REPLY_PREFIX))
  assert.equal(result.provider, 'fake')
})

test('the default reply is deterministic: identical requests give identical results, different requests differ', async () => {
  const a = createFakeProvider()
  const b = createFakeProvider()
  const first = await a.generate(request())
  assert.deepEqual(await a.generate(request()), first)
  assert.deepEqual(await b.generate(request()), first, 'a second instance gives the same answer')
  assert.notEqual((await a.generate(request({ system: 'OTHER PROMPT' }))).text, first.text)
  assert.notEqual((await a.generate(request({ model: 'other-model' }))).text, first.text)
  assert.notEqual((await a.generate(request({ maxOutputTokens: 10 }))).text, first.text)
  assert.notEqual((await a.generate(request({ messages: [{ role: 'user', content: 'Something else' }] }))).text, first.text)
  assert.equal(first.finishReason, 'stop')
  assert.equal(first.model, 'fake-model')
  assert.ok(codePoints(first.text) < 8000)
  assert.match(first.text, /\| re: What should I build first\?$/)
  // the signal is not part of the answer
  assert.deepEqual(await a.generate(request({ signal: AbortSignal.timeout(60000) })), first)
})

test('usage is a deterministic character count with the in/out shape', async () => {
  const provider = createFakeProvider()
  const result = await provider.generate(request())
  assert.deepEqual(result.usage, { in: codePoints('SYSTEM PROMPT') + codePoints('What should I build first?'), out: codePoints(result.text) })
  assert.deepEqual((await createFakeProvider({ script: [{ usage: null }] }).generate(request())).usage, null)
})

test('every accepted call is recorded with the exact system, ordered messages, model, maxOutputTokens and the real signal', async () => {
  const provider = createFakeProvider()
  const controller = new AbortController()
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ]
  await provider.generate({ system: 'S', messages, model: 'm-1', maxOutputTokens: 321, signal: controller.signal })
  assert.equal(provider.calls.length, 1)
  const [call] = provider.calls
  assert.equal(call.system, 'S')
  assert.deepEqual(call.messages.map((m) => `${m.role}:${m.content}`), ['user:first', 'assistant:second', 'user:third'])
  assert.equal(call.model, 'm-1')
  assert.equal(call.maxOutputTokens, 321)
  assert.equal(call.signal, controller.signal, 'the very AbortSignal object, not a copy')
  assert.ok(call.signal instanceof AbortSignal)
  assert.equal(call.signal.aborted, false)
  controller.abort()
  assert.equal(provider.calls[0].signal.aborted, true, 'the recorded signal is live')
})

test('recorded calls are snapshots: later mutation of the caller\'s data does not change them, and they are frozen', async () => {
  const provider = createFakeProvider()
  const messages = [{ role: 'user', content: 'original' }]
  await provider.generate(request({ messages }))
  messages[0].content = 'MUTATED'
  messages.push({ role: 'assistant', content: 'extra' })
  assert.deepEqual(provider.calls[0].messages.map((m) => m.content), ['original'])
  assert.ok(Object.isFrozen(provider.calls[0]))
  assert.ok(Object.isFrozen(provider.calls[0].messages))
  assert.ok(Object.isFrozen(provider.calls[0].messages[0]))
})

test('a contract violation rejects with a TypeError and is not recorded as a call', async () => {
  const provider = createFakeProvider({ script: [{ reply: 'never used' }] })
  await assert.rejects(provider.generate(request({ messages: [{ role: 'assistant', content: 'x' }] })), TypeError)
  await assert.rejects(provider.generate(request({ signal: {} })), TypeError)
  await assert.rejects(provider.generate(request({ userId: 'u1' })), TypeError)
  assert.equal(provider.calls.length, 0)
  // the rejected calls did not consume the script
  assert.equal((await provider.generate(request())).text, 'never used')
})

test('an array script applies per call and falls back to the default behaviour afterwards', async () => {
  const provider = createFakeProvider({ script: [{ reply: 'one' }, { reply: 'two', finishReason: 'length' }] })
  assert.equal((await provider.generate(request())).text, 'one')
  const second = await provider.generate(request())
  assert.equal(second.text, 'two')
  assert.equal(second.finishReason, 'length')
  assert.ok((await provider.generate(request())).text.startsWith(FAKE_REPLY_PREFIX))
  assert.equal(provider.calls.length, 3)
})

test('a function script sees the recorded call and its index; reply may be a function of the call', async () => {
  const seen = []
  const provider = createFakeProvider({
    script: (call, index) => {
      seen.push([index, call.messages.length])
      return index === 0 ? { reply: (c) => `echo:${c.messages.at(-1).content}` } : undefined
    },
  })
  assert.equal((await provider.generate(request())).text, 'echo:What should I build first?')
  await provider.generate(request())
  assert.deepEqual(seen, [[0, 1], [1, 1]])
})

test('scripted replies are returned exactly and without the fake prefix', async () => {
  const provider = createFakeProvider({ script: [{ reply: 'exact text' }] })
  assert.equal((await provider.generate(request())).text, 'exact text')
})

test('scripted failures: every AiProviderError kind, with an optional upstream status', async () => {
  for (const kind of PROVIDER_ERROR_KINDS) {
    const provider = createFakeProvider({ script: [{ throw: kind }] })
    await assert.rejects(provider.generate(request()), (error) => error instanceof AiProviderError && error.kind === kind && error.status === undefined, kind)
  }
  const provider = createFakeProvider({ script: [{ throw: 'unavailable', status: 503 }] })
  await assert.rejects(provider.generate(request()), (error) => error.kind === 'unavailable' && error.status === 503)
  assert.equal(provider.calls.length, 1, 'a failing call is still recorded')
})

test('oversize, blank and malformed results can be scripted', async () => {
  const provider = createFakeProvider({
    script: [{ oversize: true }, { oversize: 9000 }, { blank: true }, { returns: { text: 42 } }, { returns: 'not an object' }, { returns: null }],
  })
  const oversize = await provider.generate(request())
  assert.equal(codePoints(oversize.text), FAKE_OVERSIZE_DEFAULT)
  assert.equal(FAKE_OVERSIZE_DEFAULT, 8001)
  assert.equal(codePoints((await provider.generate(request())).text), 9000)
  const blank = await provider.generate(request())
  assert.equal(blank.text.trim(), '')
  assert.ok(blank.text.length > 0)
  assert.deepEqual(await provider.generate(request()), { text: 42 })
  assert.equal(await provider.generate(request()), 'not an object')
  assert.equal(await provider.generate(request()), null)
})

test('hang: pending until the signal aborts; a manual abort is "aborted", a deadline is "timeout"', async () => {
  const controller = new AbortController()
  const provider = createFakeProvider({ script: [{ hang: true }, { hang: true }] })
  let settled = false
  const pending = provider.generate(request({ signal: controller.signal })).finally(() => { settled = true })
  const outcome = pending.then(() => null, (error) => error)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false, 'still pending')
  assert.equal(provider.calls.length, 1, 'the call was recorded while pending')
  controller.abort()
  const error = await outcome
  assert.ok(error instanceof AiProviderError)
  assert.equal(error.kind, 'aborted')

  // AbortSignal.timeout() uses an unref'd timer, so in a bare test process nothing would keep the event loop alive
  // while the call is pending (a real server has other handles). A ref'd timer stands in for them.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const timedOut = await provider.generate(request({ signal: AbortSignal.timeout(25) })).then(() => null, (e) => e)
    assert.ok(timedOut instanceof AiProviderError)
    assert.equal(timedOut.kind, 'timeout')
  } finally {
    clearTimeout(keepAlive)
  }
})

test('an already-aborted signal rejects immediately for every behaviour, but the call is still recorded', async () => {
  const controller = new AbortController()
  controller.abort()
  const provider = createFakeProvider()
  await assert.rejects(provider.generate(request({ signal: controller.signal })), (e) => e instanceof AiProviderError && e.kind === 'aborted')
  assert.equal(provider.calls.length, 1)
  assert.equal(provider.calls[0].signal.aborted, true)
  await assert.rejects(
    createFakeProvider().generate(request({ signal: AbortSignal.abort(new DOMException('deadline', 'TimeoutError')) })),
    (e) => e.kind === 'timeout',
  )
})

test('wait: the call is recorded at once and settles only when the gate opens (concurrency tests)', async () => {
  let open
  const gate = new Promise((resolve) => { open = resolve })
  const provider = createFakeProvider({ script: [{ wait: gate, reply: 'after the gate' }] })
  let done = false
  const pending = provider.generate(request()).then((r) => { done = true; return r })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(provider.calls.length, 1)
  assert.equal(done, false)
  open()
  assert.equal((await pending).text, 'after the gate')
})

test('wait is abortable: aborting while gated rejects', async () => {
  const controller = new AbortController()
  const provider = createFakeProvider({ script: [{ wait: new Promise(() => {}) }] })
  const outcome = provider.generate(request({ signal: controller.signal })).then(() => null, (e) => e)
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  assert.equal((await outcome).kind, 'aborted')
})

test('reset clears the recorded calls and restarts the script', async () => {
  const provider = createFakeProvider({ script: [{ reply: 'first' }] })
  assert.equal((await provider.generate(request())).text, 'first')
  assert.ok((await provider.generate(request())).text.startsWith(FAKE_REPLY_PREFIX))
  provider.reset()
  assert.equal(provider.calls.length, 0)
  assert.equal((await provider.generate(request())).text, 'first')
})

test('typos in a script are caught: invalid scripts and behaviours throw TypeError', async () => {
  assert.throws(() => createFakeProvider({ script: 'nope' }), TypeError)
  const invalid = [
    null, 'x', [], { replly: 'x' }, { reply: 1 }, { reply: 'a', throw: 'timeout' }, { hang: true, blank: true },
    { throw: 'boom' }, { status: 503 }, { oversize: 0 }, { oversize: 'x' }, { blank: false }, { hang: false },
    { finishReason: 'done' }, { wait: 5 },
  ]
  for (const behavior of invalid) {
    assert.throws(() => createFakeProvider({ script: [behavior] }), TypeError, JSON.stringify(behavior))
  }
  // a function script is validated when it is consulted
  const provider = createFakeProvider({ script: () => ({ replly: 'typo' }) })
  await assert.rejects(provider.generate(request()), TypeError)
})
