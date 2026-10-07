import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanBundleText, scanDist } from '../../scripts/check-bundle-secrets.mjs'
import { scanSource } from '../../scripts/check-browser-storage.mjs'

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJlc2lnbg`

test('bundle scan flags secrets, supabase libraries/urls, keys and env values', () => {
  const bad = [
    'sb_secret_abcdef123456',
    'x service_role y',
    'process.env.SUPABASE_SERVICE_ROLE_KEY',
    'import "@supabase/ssr"',
    'fetch("https://abc.supabase.co/auth/v1/token")',
    'k="sb_publishable_abcdefg"',
    `t="${jwt({ role: 'service_role' })}"`,
    `t="${jwt({ role: 'anon', iss: 'supabase' })}"`,
    'c="__Host-ombre-auth"',
  ]
  for (const text of bad) assert.ok(scanBundleText('f.js', text).length > 0, text)
  assert.ok(scanBundleText('f.js', 'const k="0123456789abcdefXYZ"', { SUPABASE_PUBLISHABLE_KEY: '0123456789abcdefXYZ' }).length > 0)
})

test('bundle scan passes ordinary application code', () => {
  const clean = 'const a=localStorage.getItem("ombre-theme");fetch("/api/auth/session",{credentials:"same-origin"})'
  assert.deepEqual(scanBundleText('f.js', clean, { SUPABASE_URL: 'https://abc.supabase.co' }), [])
})

test('scanDist walks a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dist-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<html></html>')
  writeFileSync(join(dir, 'assets', 'a.js'), 'ok()')
  assert.deepEqual(scanDist(dir, {}), [])
  writeFileSync(join(dir, 'assets', 'b.js'), 'sb_secret_zzzzzzzzzz')
  assert.equal(scanDist(dir, {}).length, 1)
})

test('storage scan: only the approved keys and APIs', () => {
  assert.deepEqual(scanSource('a.jsx', "window.localStorage.getItem('ombre-theme'); localStorage.removeItem(STORAGE_KEY)"), [])
  assert.ok(scanSource('a.jsx', "localStorage.setItem('token', x)").length === 1)
  assert.ok(scanSource('a.jsx', 'localStorage.setItem(someVar, x)').length === 1)
  assert.ok(scanSource('a.jsx', "sessionStorage.getItem('a')").length === 1)
  assert.ok(scanSource('a.jsx', 'indexedDB.open("x")').length === 1)
  assert.ok(scanSource('a.jsx', "import { createClient } from '@supabase/supabase-js'").length === 1)
  assert.ok(scanSource('a.jsx', 'document.cookie = "a=b"').length === 1)
  assert.ok(scanSource('a.jsx', 'const k = import.meta.env.VITE_SUPABASE_URL').length === 1)
})
