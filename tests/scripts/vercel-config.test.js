import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rewriteMatcher, assetRefs, checkDist } from '../../scripts/check-dist-assets.mjs'

const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))

test('SPA fallback still exists and points at /index.html', () => {
  assert.equal(config.rewrites.length, 1)
  assert.equal(config.rewrites[0].destination, '/index.html')
})

test('client-side routes fall back to index.html', () => {
  const rewritten = rewriteMatcher(config)
  for (const path of [
    '/', '/login', '/signup', '/forgot-password', '/reset-password', '/auth/callback', '/auth/callback/recovery',
    '/app/general', '/app/general/3f2b8c1e-aaaa-4bbb-8ccc-123456789abc', '/app/projects', '/app/projects/abc',
    '/app/mentors', '/app/mentors/a/b/c', '/app/library', '/app/history', '/app/memory', '/app/profile', '/app/settings',
    '/some/unknown/route',
  ]) {
    assert.ok(rewritten(path), `${path} should fall back to the SPA`)
  }
})

test('static assets, files with an extension and /api/* are never rewritten', () => {
  const rewritten = rewriteMatcher(config)
  for (const path of [
    '/assets/index-AbC123.js', '/assets/index-AbC123.css', '/assets/nested/chunk-1.js', '/assets/font.woff2',
    '/favicon.ico', '/robots.txt', '/vite.svg', '/index.html',
    '/api/auth/session', '/api/auth/signin', '/api/user/profile', '/api/user/settings',
  ]) {
    assert.ok(!rewritten(path), `${path} must not be rewritten to /index.html`)
  }
})

test('security headers are unchanged: every non-API path and every API path keeps its full header set', () => {
  const byName = (source) => Object.fromEntries(config.headers.find((h) => h.source === source).headers.map((h) => [h.key, h.value]))
  const app = byName('/((?!api/).*)')
  assert.deepEqual(Object.keys(app).sort(), [
    'Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Permissions-Policy', 'Referrer-Policy',
    'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options',
  ])
  assert.match(app['Content-Security-Policy'], /^default-src 'self'; script-src 'self';/)
  assert.equal(app['X-Content-Type-Options'], 'nosniff')
  assert.equal(app['X-Frame-Options'], 'DENY')
  const api = byName('/api/(.*)')
  assert.equal(api['Content-Security-Policy'], "default-src 'none'; frame-ancestors 'none'")
  assert.match(api['Cache-Control'], /no-store/)
  assert.equal(api['X-Content-Type-Options'], 'nosniff')
  // the header patterns still cover assets (nosniff + CSP apply to them) and still exclude /api from the app set
  const appRe = new RegExp('^(?:' + config.headers[0].source + ')$')
  assert.ok(appRe.test('/assets/index-AbC123.js'))
  assert.ok(!appRe.test('/api/user/profile'))
})

function fakeDist(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dist-'))
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return dir
}
const INDEX = '<!doctype html><html><head><link rel="stylesheet" crossorigin href="/assets/index-AbC.css"><script type="module" crossorigin src="/assets/index-AbC.js"></script></head><body><div id="root"></div></body></html>'

test('assetRefs extracts the built script and stylesheet URLs', () => {
  assert.deepEqual(assetRefs(INDEX).sort(), ['/assets/index-AbC.css', '/assets/index-AbC.js'])
})

test('checkDist passes for a real-looking build and reports the Content-Type each asset gets', () => {
  const dir = fakeDist({ 'index.html': INDEX, 'assets/index-AbC.js': 'console.log(1)', 'assets/index-AbC.css': 'body{margin:0}' })
  const { problems, report } = checkDist(dir, config)
  assert.deepEqual(problems, [])
  assert.deepEqual(report.sort(), ['/assets/index-AbC.css -> text/css', '/assets/index-AbC.js -> text/javascript'])
})

test('checkDist fails when an asset is missing, is HTML, or would be caught by the rewrite', () => {
  const missing = checkDist(fakeDist({ 'index.html': INDEX, 'assets/index-AbC.css': 'a{}' }), config)
  assert.ok(missing.problems.some((p) => /index-AbC\.js: not present/.test(p)))
  const html = checkDist(fakeDist({ 'index.html': INDEX, 'assets/index-AbC.js': '<!doctype html><html></html>', 'assets/index-AbC.css': 'a{}' }), config)
  assert.ok(html.problems.some((p) => /content is HTML/.test(p)))
  const oldConfig = { rewrites: [{ source: '/((?!api/).*)', destination: '/index.html' }] }
  const caught = checkDist(fakeDist({ 'index.html': INDEX, 'assets/index-AbC.js': 'x', 'assets/index-AbC.css': 'a{}' }), oldConfig)
  assert.equal(caught.problems.length, 2)
  assert.ok(caught.problems.every((p) => /matches the SPA rewrite/.test(p)))
  assert.ok(checkDist(fakeDist({}), config).problems[0].includes('run npm run build first'))
})
