import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { loadAiConfig } from '../../api/_lib/ai/config.js'
import { AiProviderError, PROVIDER_ERROR_KINDS } from '../../api/_lib/ai/provider.js'
import { createFakeProvider } from '../../api/_lib/ai/providers/fake.js'
import { GENERAL_AI_PROMPT, PromptError } from '../../api/_lib/ai/prompts.js'
import { MENTOR_PROMPTS } from '../../api/_lib/ai/mentorPromptsData.js'
import { ContextError, MESSAGE_SEPARATOR } from '../../api/_lib/ai/context.js'
import { AiOutputError, MAX_REPLY_CODE_POINTS, OUTPUT_FAILURE_REASONS, generateReply, validateProviderResult } from '../../api/_lib/ai/generate.js'

const config = loadAiConfig({ AI_PROVIDER: 'fake', AI_MODEL: 'fake-model', VERCEL_ENV: 'preview' })
const row = (seq, role, content, is_demo = false) => ({ seq, role, content, is_demo })
const ROWS = [row(1, 'user', 'What should I build first?')]
const run = (provider, over = {}) => generateReply({ provider, config, mentorId: null, rows: ROWS, targetSeq: 1, ...over })
const codePoints = (s) => Array.from(s).length

test('General AI: the exact approved prompt, the persisted history, and the configured model and token limit', async () => {
  const provider = createFakeProvider()
  const rows = [row(1, 'user', 'first'), row(2, 'assistant', 'answer'), row(3, 'user', 'second')]
  const result = await run(provider, { rows, targetSeq: 3 })
  assert.equal(provider.calls.length, 1)
  const [call] = provider.calls
  assert.equal(call.system, GENERAL_AI_PROMPT)
  assert.deepEqual(call.messages.map((m) => `${m.role}:${m.content}`), ['user:first', 'assistant:answer', 'user:second'])
  assert.equal(call.model, 'fake-model')
  assert.equal(call.maxOutputTokens, 1500)
  assert.ok(call.signal instanceof AbortSignal)
  assert.equal(call.signal.aborted, false)
  assert.ok(result.text.startsWith('[FAKE PROVIDER - TEST ONLY]'))
})

test('every mentor conversation uses only its own mentor prompt', async () => {
  for (const id of Object.keys(MENTOR_PROMPTS)) {
    const provider = createFakeProvider()
    await run(provider, { mentorId: id })
    assert.equal(provider.calls[0].system, MENTOR_PROMPTS[id], id)
    assert.ok(!provider.calls[0].system.includes(GENERAL_AI_PROMPT), id)
  }
})

test('an unknown mentor id fails before any provider call: no fallback', async () => {
  for (const mentorId of ['nope', '', undefined, 'constructor', 'Startup-Validator']) {
    const provider = createFakeProvider()
    await assert.rejects(run(provider, { mentorId }), (error) => error instanceof PromptError)
    assert.equal(provider.calls.length, 0)
  }
})

test('the provider receives exactly the S4-A contract fields and nothing else', async () => {
  let seen
  const spy = {
    async generate(request) {
      seen = request
      return { text: 'ok', finishReason: 'stop', usage: null }
    },
  }
  await run(spy)
  assert.deepEqual(Object.keys(seen).sort(), ['maxOutputTokens', 'messages', 'model', 'signal', 'system'])
  assert.deepEqual(seen.messages, [{ role: 'user', content: 'What should I build first?' }])
  assert.deepEqual(Object.keys(seen.messages[0]).sort(), ['content', 'role'])
})

test('history is trimmed and shaped by the context builder: demo dropped, blanks dropped, same-role runs merged', async () => {
  const provider = createFakeProvider()
  const rows = [row(1, 'user', 'a'), row(2, 'assistant', 'DEMO', true), row(3, 'user', 'b'), row(4, 'assistant', '\n\n'), row(5, 'user', 'c')]
  const result = await run(provider, { rows, targetSeq: 5 })
  assert.deepEqual(provider.calls[0].messages.map((m) => m.content), [`a${MESSAGE_SEPARATOR}b${MESSAGE_SEPARATOR}c`])
  assert.equal(result.meta.droppedDemo, 1)
  assert.equal(result.meta.droppedBlank, 1)
})

test('context errors propagate and no provider call is made', async () => {
  const provider = createFakeProvider()
  await assert.rejects(run(provider, { rows: [row(1, 'user', 'a')], targetSeq: 2 }), (e) => e instanceof ContextError && e.code === 'target_missing')
  await assert.rejects(run(provider, { rows: [row(1, 'user', '  ')], targetSeq: 1 }), (e) => e instanceof ContextError && e.code === 'target_unusable')
  assert.equal(provider.calls.length, 0)
})

test('the default deadline signal is derived from config.timeoutMs and maps to a timeout', async () => {
  const keepAlive = setTimeout(() => {}, 1000) // AbortSignal.timeout's timer is unref'd; a real server has other handles
  const hanging = createFakeProvider({ script: [{ hang: true }] })
  try {
    await assert.rejects(
      generateReply({ provider: hanging, config: { ...config, timeoutMs: 25 }, mentorId: null, rows: ROWS, targetSeq: 1 }),
      (error) => error instanceof AiProviderError && error.kind === 'timeout',
    )
    assert.equal(hanging.calls[0].signal.aborted, true)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('a caller-supplied signal is passed through by identity, and aborting it is "aborted"', async () => {
  const controller = new AbortController()
  const provider = createFakeProvider({ script: [{ hang: true }] })
  const pending = run(provider, { signal: controller.signal }).then(() => null, (e) => e)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(provider.calls[0].signal, controller.signal)
  controller.abort()
  const error = await pending
  assert.ok(error instanceof AiProviderError)
  assert.equal(error.kind, 'aborted')
})

test('provider failures pass through unchanged and are never retried', async () => {
  for (const kind of PROVIDER_ERROR_KINDS) {
    const provider = createFakeProvider({ script: [{ throw: kind, status: 502 }, { reply: 'a retry would have succeeded' }] })
    await assert.rejects(run(provider), (error) => error instanceof AiProviderError && error.kind === kind && error.status === 502, kind)
    assert.equal(provider.calls.length, 1, `${kind}: no retry`)
  }
})

test('provider contract violations (a TypeError) propagate as programming errors', async () => {
  const broken = { generate: async () => { throw new TypeError('provider bug') } }
  await assert.rejects(run(broken), TypeError)
  await assert.rejects(generateReply({ provider: null, config, mentorId: null, rows: ROWS, targetSeq: 1 }), TypeError)
  await assert.rejects(generateReply({ provider: {}, config, mentorId: null, rows: ROWS, targetSeq: 1 }), TypeError)
  await assert.rejects(generateReply({ provider: createFakeProvider(), config: null, mentorId: null, rows: ROWS, targetSeq: 1 }), TypeError)
})

// ------------------------------------------------------------------------------------------ output validation

const reasonOf = async (result) => {
  try {
    validateProviderResult(result)
  } catch (error) {
    assert.ok(error instanceof AiOutputError, String(error))
    return error.reason
  }
  return null
}

test('accepted output is returned exactly as the provider gave it: nothing trimmed, truncated or appended', async () => {
  for (const text of ['plain', '  leading and trailing  ', 'line one\n\nline two\n', '\n\nstarts blank', 'e\u0301 \u4e2d\u6587 \u{1F600}', 'x'.repeat(8000)]) {
    const result = await run(createFakeProvider({ script: [{ reply: text }] }))
    assert.equal(result.text, text)
  }
  assert.equal(MAX_REPLY_CODE_POINTS, 8000)
})

test('the 8000-code-point limit is exact and counts code points', async () => {
  assert.equal(await reasonOf({ text: 'x'.repeat(8000) }), null)
  assert.equal(await reasonOf({ text: '\u{1F600}'.repeat(8000) }), null, '8000 emoji are 16000 UTF-16 units but 8000 code points')
  assert.equal(await reasonOf({ text: 'x'.repeat(8001) }), 'oversize')
  assert.equal(await reasonOf({ text: '\u{1F600}'.repeat(8001) }), 'oversize')
  try {
    validateProviderResult({ text: '\u{1F600}'.repeat(8003) })
  } catch (error) {
    assert.equal(error.replyChars, 8003)
  }
})

test('oversize, blank, invalid and malformed output are failures with a reason, never repaired', async () => {
  assert.equal(await reasonOf({ text: '' }), 'blank')
  assert.equal(await reasonOf({ text: ' \n\t ' }), 'blank')
  assert.equal(await reasonOf({ text: '\n\n' }), 'blank')
  assert.equal(await reasonOf({ text: '\u00a0\u2003' }), 'blank')
  assert.equal(await reasonOf({ text: 'has a NUL \u0000 inside' }), 'invalid_text')
  assert.equal(await reasonOf({ text: 'lone high \ud800 surrogate' }), 'invalid_text')
  assert.equal(await reasonOf({ text: 'lone low \udc00 surrogate' }), 'invalid_text')
  for (const bad of [null, undefined, 'a string', 42, true, [], ['text'], {}, { text: 42 }, { text: null }, { text: ['x'] }, { content: 'wrong field' }]) {
    assert.equal(await reasonOf(bad), 'malformed_result', JSON.stringify(bad))
  }
  assert.deepEqual([...OUTPUT_FAILURE_REASONS], ['malformed_result', 'invalid_text', 'blank', 'oversize'])
  // through the whole pipeline, with the fake provider's scripted shapes
  for (const [behavior, reason] of [[{ oversize: true }, 'oversize'], [{ blank: true }, 'blank'], [{ returns: { text: 42 } }, 'malformed_result'], [{ returns: null }, 'malformed_result']]) {
    await assert.rejects(run(createFakeProvider({ script: [behavior] })), (error) => error instanceof AiOutputError && error.reason === reason, reason)
  }
})

test('AiOutputError keeps no text: only a reason and, for oversize, a length', () => {
  const secret = 'SECRET-REPLY-TEXT '.repeat(1000)
  try {
    validateProviderResult({ text: secret })
    assert.fail('expected oversize')
  } catch (error) {
    assert.ok(error instanceof AiOutputError)
    assert.equal(error.reason, 'oversize')
    assert.equal(error.replyChars, codePoints(secret))
    assert.ok(!inspect(error).includes('SECRET'))
    assert.ok(!JSON.stringify(error).includes('SECRET'))
    assert.ok(!error.message.includes('SECRET'))
  }
  assert.throws(() => new AiOutputError('boom'), TypeError)
  assert.equal(new AiOutputError('blank', { replyChars: -1 }).replyChars, undefined)
})

test('finishReason and usage are preserved when valid, normalized when not (metadata never fails a good reply)', async () => {
  const kept = await run(createFakeProvider({ script: [{ reply: 'ok', finishReason: 'length', usage: { in: 10, out: 20 } }] }))
  assert.equal(kept.finishReason, 'length')
  assert.deepEqual(kept.usage, { in: 10, out: 20 })
  assert.equal((await run(createFakeProvider({ script: [{ reply: 'ok', usage: null }] }))).usage, null)
  const spy = (extra) => ({ generate: async () => ({ text: 'ok', ...extra }) })
  assert.equal((await run(spy({ finishReason: 'banana' }))).finishReason, 'other')
  assert.equal((await run(spy({}))).finishReason, 'other')
  for (const usage of [undefined, 'x', 5, { in: -1, out: 1 }, { in: 1.5, out: 1 }, { in: 1 }, { in: '1', out: '2' }, []]) {
    assert.equal((await run(spy({ finishReason: 'stop', usage }))).usage, null, JSON.stringify(usage))
  }
  const copy = { in: 3, out: 4, extra: 'dropped' }
  assert.deepEqual((await run(spy({ finishReason: 'stop', usage: copy }))).usage, { in: 3, out: 4 })
})

test('meta holds only identifiers and counts, ready for the logging layer', async () => {
  const provider = createFakeProvider()
  const result = await run(provider, { mentorId: 'bug-hunter' })
  assert.deepEqual(Object.keys(result.meta).sort(), [
    'droppedBlank', 'droppedByBudget', 'droppedByCap', 'droppedDemo', 'historyMessages', 'latencyMs', 'mentorId',
    'mergedMessages', 'model', 'promptChars', 'provider', 'replyChars',
  ])
  assert.equal(result.meta.provider, 'fake')
  assert.equal(result.meta.model, 'fake-model')
  assert.equal(result.meta.mentorId, 'bug-hunter')
  assert.equal(result.meta.replyChars, codePoints(result.text))
  assert.ok(Number.isInteger(result.meta.latencyMs) && result.meta.latencyMs >= 0)
  assert.ok(result.meta.promptChars > codePoints(MENTOR_PROMPTS['bug-hunter']))
  for (const value of Object.values(result.meta)) assert.ok(typeof value === 'string' || typeof value === 'number' || value === null)
  assert.equal((await run(createFakeProvider())).meta.mentorId, null)
  assert.ok(!JSON.stringify(result.meta).includes(ROWS[0].content), 'no message text in meta')
})
