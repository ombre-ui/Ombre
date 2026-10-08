import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEmail, parseExistingPassword, parseNewPassword, parseAuthCode, parseFlowId, parsePurpose, parseJsonObject } from '../../api/_lib/validate.js'
import { ApiError } from '../../api/_lib/errors.js'

const throwsApi = (fn, code) =>
  assert.throws(fn, (e) => e instanceof ApiError && e.status === 400 && (code ? e.code === code : true))

test('email: normalizes and bounds', () => {
  assert.equal(parseEmail('  Person@Example.COM '), 'person@example.com')
  for (const bad of ['', 'x', 'a@b', 'a b@c.io', 'a@@c.io', 5, null, undefined, `${'a'.repeat(250)}@x.io`]) throwsApi(() => parseEmail(bad))
})

test('new password: 12 characters minimum, 72 bytes maximum', () => {
  assert.equal(parseNewPassword('a'.repeat(12)), 'a'.repeat(12))
  throwsApi(() => parseNewPassword('a'.repeat(11)), 'weak_password')
  throwsApi(() => parseNewPassword('a'.repeat(73)), 'weak_password')
  throwsApi(() => parseNewPassword('é'.repeat(37)), 'weak_password') // 74 bytes
  throwsApi(() => parseNewPassword(1234567890123))
})

test('existing password: bounded but no policy', () => {
  assert.equal(parseExistingPassword('short'), 'short')
  throwsApi(() => parseExistingPassword(''))
  throwsApi(() => parseExistingPassword('x'.repeat(73)))
})

test('auth code and flow id shapes', () => {
  assert.equal(parseAuthCode('2f1c9a5e-0b7d-4c1e-9f3a-123456789abc'), '2f1c9a5e-0b7d-4c1e-9f3a-123456789abc')
  for (const bad of ['', 'short', 'has space in it!!', 'x'.repeat(300), 12, null]) throwsApi(() => parseAuthCode(bad), 'link_invalid_or_expired')
  assert.equal(parseFlowId(undefined), null)
  assert.equal(parseFlowId('abcdefgh12345678'), 'abcdefgh12345678')
  throwsApi(() => parseFlowId('../x'), 'link_invalid_or_expired')
  assert.equal(parsePurpose(undefined), null)
  assert.equal(parsePurpose('recovery'), 'recovery')
  throwsApi(() => parsePurpose('admin'))
})

test('json body: objects only, unknown keys rejected', () => {
  assert.deepEqual(parseJsonObject('{"email":"a"}', ['email']), { email: 'a' })
  throwsApi(() => parseJsonObject('not json', ['email']))
  throwsApi(() => parseJsonObject('[1]', ['email']))
  throwsApi(() => parseJsonObject('null', ['email']))
  throwsApi(() => parseJsonObject('{"email":"a","role":"admin"}', ['email']))
})
