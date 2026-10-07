import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCookieHeader, serializeSetCookie, createCookieJar } from '../../api/_lib/cookies.js'
import { prodConfig, devConfig, makeRequest } from './helpers.js'

const attrs = (setCookie) => setCookie.split(';').map((s) => s.trim())

test('production cookies: __Host- name, HttpOnly, Secure, Path=/, SameSite=Lax, no Domain', () => {
  const config = prodConfig()
  const jar = createCookieJar({ request: makeRequest('/x'), config })
  jar.setAll([{ name: config.cookieName, value: 'base64-abc', options: { maxAge: 400 * 86400, domain: '.evil.com', httpOnly: false, sameSite: 'none', path: '/x' } }], {})
  const [header] = jar.setCookieHeaders()
  const a = attrs(header)
  assert.ok(header.startsWith('__Host-ombre-auth='))
  assert.ok(a.includes('HttpOnly') && a.includes('Secure') && a.includes('Path=/') && a.includes('SameSite=Lax'))
  assert.ok(!/domain/i.test(header))
  assert.ok(a.includes(`Max-Age=${30 * 86400}`), 'session cookie capped at 30 days')
})

test('verifier cookies are capped at one hour', () => {
  const config = prodConfig()
  const jar = createCookieJar({ request: makeRequest('/x'), config })
  jar.setAll(
    [
      { name: `${config.cookieName}-code-verifier`, value: 'v', options: { maxAge: 34560000 } },
      { name: `${config.cookieName}-flow-abcdefgh12-code-verifier`, value: 'v', options: { maxAge: 34560000 } },
      { name: `${config.cookieName}-flows-code-verifier`, value: '[]', options: { maxAge: 34560000 } },
    ],
    {}
  )
  for (const h of jar.setCookieHeaders()) assert.ok(attrs(h).includes('Max-Age=3600'), h)
})

test('chunked session cookies keep the same policy', () => {
  const config = prodConfig()
  const jar = createCookieJar({ request: makeRequest('/x'), config })
  jar.setAll([{ name: `${config.cookieName}.0`, value: 'a', options: {} }, { name: `${config.cookieName}.1`, value: 'b', options: {} }], {})
  assert.equal(jar.setCookieHeaders().length, 2)
  for (const h of jar.setCookieHeaders()) assert.ok(attrs(h).includes('Secure') && attrs(h).includes('HttpOnly'))
})

test('foreign cookie names are never written', () => {
  const config = prodConfig()
  const jar = createCookieJar({ request: makeRequest('/x'), config })
  jar.setAll([{ name: 'tracking', value: '1', options: {} }, { name: 'sb-other-auth-token', value: '1', options: {} }], {})
  assert.equal(jar.setCookieHeaders().length, 0)
})

test('local development: unprefixed name, no Secure flag', () => {
  const config = devConfig()
  const jar = createCookieJar({ request: makeRequest('/x', { origin: 'http://localhost:3000' }), config })
  jar.setAll([{ name: config.cookieName, value: 'v', options: {} }], {})
  const [h] = jar.setCookieHeaders()
  assert.ok(h.startsWith('ombre-auth=') && !h.includes('Secure') && h.includes('HttpOnly'))
})

test('__Host- cookies refuse to serialize without Secure', () => {
  assert.throws(() => serializeSetCookie({ name: '__Host-x', value: 'v', maxAge: 10, secure: false }))
  assert.throws(() => serializeSetCookie({ name: 'bad name', value: 'v', maxAge: 10, secure: true }))
})

test('expiry: all request auth cookies (chunks + verifier slots) are expired, others untouched', () => {
  const config = prodConfig()
  const cookie = [`${config.cookieName}.0=a`, `${config.cookieName}.1=b`, `${config.cookieName}-flow-abcdefgh12-code-verifier=c`, 'theme=dark'].join('; ')
  const jar = createCookieJar({ request: makeRequest('/x', { cookie }), config })
  jar.expireAllAuthCookies()
  const headers = jar.setCookieHeaders()
  assert.equal(headers.length, 3)
  for (const h of headers) assert.ok(h.includes('Max-Age=0') && h.includes('Expires=Thu, 01 Jan 1970') && h.includes('Secure') && h.includes('HttpOnly') && h.includes('Path=/'))
  assert.ok(!headers.some((h) => h.startsWith('theme=')))
})

test('cookie values round-trip through encode/decode and cache headers are collected', () => {
  const config = prodConfig()
  const value = 'base64-eyJhIjoiYiJ9=='
  const jar = createCookieJar({ request: makeRequest('/x'), config })
  jar.setAll([{ name: config.cookieName, value, options: {} }], { 'Cache-Control': 'private, no-store' })
  const [h] = jar.setCookieHeaders()
  const parsed = parseCookieHeader(h.split(';')[0])
  assert.deepEqual(parsed, [{ name: config.cookieName, value }])
  assert.equal(jar.extraHeaders()['Cache-Control'], 'private, no-store')
})

test('parseCookieHeader tolerates junk', () => {
  assert.deepEqual(parseCookieHeader('a=1; ; =x; b=%E0%A4%A; c="q"'), [
    { name: 'a', value: '1' },
    { name: 'b', value: '%E0%A4%A' },
    { name: 'c', value: 'q' },
  ])
  assert.deepEqual(parseCookieHeader(null), [])
})
