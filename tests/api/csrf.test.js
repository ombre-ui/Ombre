import test from 'node:test'
import assert from 'node:assert/strict'
import { checkRequestOrigin } from '../../api/_lib/csrf.js'
import { ApiError } from '../../api/_lib/errors.js'
import { prodConfig, makeRequest, ORIGIN } from './helpers.js'

const config = prodConfig()

function blocked(request) {
  try {
    checkRequestOrigin(request, config)
    return false
  } catch (e) {
    assert.ok(e instanceof ApiError)
    assert.equal(e.status, 403)
    return true
  }
}

test('accepts the exact allowed origin with the custom header', () => {
  assert.equal(checkRequestOrigin(makeRequest('/api/auth/signin'), config), ORIGIN)
})

test('rejects missing, null, mismatched and near-miss origins', () => {
  for (const origin of [undefined, 'null', 'https://evil.example', 'http://app.example.com', 'https://app.example.com:8443', 'https://APP.example.com', 'https://app.example.com/', 'https://app.example.com.evil.io']) {
    assert.equal(blocked(makeRequest('/api/auth/signin', { origin })), true, String(origin))
  }
})

test('rejects non-GET requests without the custom header', () => {
  assert.equal(blocked(makeRequest('/api/auth/signin', { csrf: false })), true)
  assert.equal(blocked(makeRequest('/api/auth/signin', { headers: { 'x-ombre-request': '0' }, csrf: false })), true)
})

test('rejects cross-site fetch metadata for every method, allows same-origin and none', () => {
  assert.equal(blocked(makeRequest('/api/auth/session', { method: 'GET', origin: undefined, csrf: false, headers: { 'sec-fetch-site': 'cross-site' } })), true)
  assert.equal(blocked(makeRequest('/api/auth/signin', { headers: { 'sec-fetch-site': 'cross-site' } })), true)
  assert.equal(blocked(makeRequest('/api/auth/session', { method: 'GET', origin: undefined, csrf: false, headers: { 'sec-fetch-site': 'same-origin' } })), false)
  assert.equal(blocked(makeRequest('/api/auth/session', { method: 'GET', origin: undefined, csrf: false, headers: { 'sec-fetch-site': 'none' } })), false)
})

test('GET without Origin is allowed (safe method)', () => {
  assert.equal(checkRequestOrigin(makeRequest('/api/auth/session', { method: 'GET', origin: undefined, csrf: false }), config), null)
})
