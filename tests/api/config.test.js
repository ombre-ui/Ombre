import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, parseOrigins, ConfigError } from '../../api/_lib/config.js'
import { prodConfig, devConfig } from './helpers.js'

test('production uses the __Host- cookie name and Secure', () => {
  const c = prodConfig()
  assert.equal(c.cookieName, '__Host-ombre-auth')
  assert.equal(c.secureCookies, true)
  assert.equal(c.sessionMaxAge, 30 * 24 * 3600)
  assert.equal(c.verifierMaxAge, 3600)
})

test('local development uses the unprefixed cookie name', () => {
  const c = devConfig()
  assert.equal(c.cookieName, 'ombre-auth')
  assert.equal(c.secureCookies, false)
})

test('insecure cookies are never enabled for non-local origins', () => {
  const c = loadConfig({
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
    APP_ORIGINS: 'https://staging.example.com',
    VERCEL_ENV: 'development',
    AUTH_ALLOW_INSECURE_COOKIES: 'true',
  })
  assert.equal(c.secureCookies, true)
  assert.equal(c.cookieName, '__Host-ombre-auth')
})

test('local http origins are rejected in production', () => {
  assert.throws(
    () =>
      loadConfig({
        SUPABASE_URL: 'https://abc.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
        APP_ORIGINS: 'http://localhost:3000',
        VERCEL_ENV: 'production',
      }),
    ConfigError
  )
})

test('origins must be exact: no paths, wildcards, or plain http on public hosts', () => {
  for (const bad of ['https://app.example.com/', 'https://app.example.com/x', 'https://*.example.com', 'http://app.example.com', 'ftp://x.com', 'nope', '']) {
    assert.throws(() => parseOrigins(bad), ConfigError, bad)
  }
  assert.deepEqual(parseOrigins('https://a.example.com, https://a.example.com,http://localhost:3000'), [
    'https://a.example.com',
    'http://localhost:3000',
  ])
})

test('secret and service-role keys are refused', () => {
  const base = { SUPABASE_URL: 'https://abc.supabase.co', APP_ORIGINS: 'https://app.example.com' }
  assert.throws(() => loadConfig({ ...base, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' }), ConfigError)
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')
  assert.throws(() => loadConfig({ ...base, SUPABASE_PUBLISHABLE_KEY: `aaa.${payload}.bbb` }), ConfigError)
  const anon = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')
  assert.doesNotThrow(() => loadConfig({ ...base, SUPABASE_PUBLISHABLE_KEY: `aaa.${anon}.bbb` }))
})
