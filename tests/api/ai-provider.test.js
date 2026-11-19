import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import {
  AiProviderError,
  FINISH_REASONS,
  MESSAGE_ROLES,
  PROVIDER_ERROR_KINDS,
  assertGenerateRequest,
  isAiProviderError,
} from '../../api/_lib/ai/provider.js'

const valid = (over = {}) => ({
  system: 'You are a test system prompt.',
  messages: [{ role: 'user', content: 'hello' }],
  model: 'test-model',
  maxOutputTokens: 1500,
  signal: new AbortController().signal,
  ...over,
})

test('the contract constants are exactly the approved sets', () => {
  assert.deepEqual([...PROVIDER_ERROR_KINDS], ['timeout', 'unavailable', 'rate_limited', 'malformed', 'refused', 'aborted'])
  assert.deepEqual([...FINISH_REASONS], ['stop', 'length', 'other'])
  assert.deepEqual([...MESSAGE_ROLES], ['user', 'assistant'])
  assert.ok(Object.isFrozen(PROVIDER_ERROR_KINDS) && Object.isFrozen(FINISH_REASONS) && Object.isFrozen(MESSAGE_ROLES))
})

test('AiProviderError carries a fixed kind and optional upstream status, and nothing else', () => {
  for (const kind of PROVIDER_ERROR_KINDS) {
    const error = new AiProviderError(kind)
    assert.ok(error instanceof Error)
    assert.ok(isAiProviderError(error))
    assert.equal(error.name, 'AiProviderError')
    assert.equal(error.kind, kind)
    assert.equal(error.message, kind)
    assert.equal(error.status, undefined)
  }
  assert.equal(new AiProviderError('unavailable', { status: 503 }).status, 503)
  for (const bad of [99, 600, 503.5, '503', null, undefined, NaN]) {
    assert.equal(new AiProviderError('unavailable', { status: bad }).status, undefined, `status ${String(bad)} ignored`)
  }
  assert.equal(isAiProviderError(new Error('x')), false)
  assert.equal(isAiProviderError(null), false)
})

test('AiProviderError rejects an unknown kind and never keeps an upstream body, message or cause', () => {
  assert.throws(() => new AiProviderError('boom'), TypeError)
  assert.throws(() => new AiProviderError(undefined), TypeError)
  const error = new AiProviderError('malformed', { status: 502, body: 'SECRET-UPSTREAM-BODY', message: 'SECRET-UPSTREAM-MESSAGE', cause: new Error('SECRET-CAUSE') })
  assert.equal(error.cause, undefined)
  assert.ok(!inspect(error).includes('SECRET'))
  assert.ok(!JSON.stringify(error).includes('SECRET'))
  assert.ok(!String(error.stack).includes('SECRET'))
})

test('assertGenerateRequest accepts a valid request and returns it', () => {
  const request = valid()
  assert.equal(assertGenerateRequest(request), request)
  const multi = valid({
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ],
  })
  assert.equal(assertGenerateRequest(multi), multi)
  // a history that starts with an assistant message is allowed by the contract (the context builder decides)
  assert.doesNotThrow(() => assertGenerateRequest(valid({ messages: [{ role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] })))
})

test('assertGenerateRequest rejects every contract violation with a TypeError', () => {
  const bad = {
    'not an object': null,
    'an array': [],
    'missing system': valid({ system: undefined }),
    'blank system': valid({ system: '  \n' }),
    'non-string system': valid({ system: 42 }),
    'no messages': valid({ messages: [] }),
    'messages not an array': valid({ messages: 'hi' }),
    'message not an object': valid({ messages: ['hi'] }),
    'message with an extra field': valid({ messages: [{ role: 'user', content: 'a', id: 'x' }] }),
    'message missing content': valid({ messages: [{ role: 'user' }] }),
    'unknown role': valid({ messages: [{ role: 'system', content: 'a' }] }),
    'blank content': valid({ messages: [{ role: 'user', content: ' \n ' }] }),
    'non-string content': valid({ messages: [{ role: 'user', content: 1 }] }),
    'consecutive user messages': valid({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] }),
    'consecutive assistant messages': valid({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }] }),
    'last message is the assistant': valid({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
    'missing model': valid({ model: undefined }),
    'blank model': valid({ model: '  ' }),
    'zero maxOutputTokens': valid({ maxOutputTokens: 0 }),
    'fractional maxOutputTokens': valid({ maxOutputTokens: 10.5 }),
    'string maxOutputTokens': valid({ maxOutputTokens: '1500' }),
    'missing signal': valid({ signal: undefined }),
    'plain object signal': valid({ signal: { aborted: false, addEventListener() {} } }),
    'an unexpected field (a user id must never reach a provider)': valid({ userId: 'u1' }),
    'an unexpected temperature': valid({ temperature: 1 }),
  }
  for (const [name, request] of Object.entries(bad)) {
    assert.throws(() => assertGenerateRequest(request), TypeError, name)
  }
})

test('contract error messages never contain prompt or message content', () => {
  for (const request of [
    valid({ system: 'SECRET-SYSTEM', messages: [{ role: 'user', content: 'SECRET-USER' }, { role: 'user', content: 'SECRET-USER-2' }] }),
    valid({ system: 'SECRET-SYSTEM', userId: 'SECRET-ID' }),
    valid({ system: 'SECRET-SYSTEM', messages: [{ role: 'assistant', content: 'SECRET-ASSISTANT' }] }),
  ]) {
    try {
      assertGenerateRequest(request)
      assert.fail('expected a TypeError')
    } catch (error) {
      assert.ok(error instanceof TypeError)
      assert.ok(!error.message.includes('SECRET'), error.message)
    }
  }
})
