import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rewriteMatcher, assetRefs, checkDist } from '../../scripts/check-dist-assets.mjs'

const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))

// The SPA fallback is identified by its destination, not by its position or by being the only rewrite: the A4
// workspace rewrites (to the single /api/workspace function) sit in front of it.
const spaRewrites = config.rewrites.filter((r) => r.destination === '/index.html')
const workspaceRewrites = config.rewrites.filter((r) => r.destination === '/api/workspace')
// Config containing only the SPA fallback: the behaviour assertions below test that rewrite on its own, exactly
// as they did when it was the only rewrite.
const spaConfig = { ...config, rewrites: spaRewrites }

test('SPA fallback still exists and points at /index.html', () => {
  assert.equal(spaRewrites.length, 1, 'exactly one rewrite sends to /index.html')
  assert.equal(spaRewrites[0].destination, '/index.html')
  // It stays last, so the API rewrites are evaluated before the catch-all-style fallback.
  assert.equal(config.rewrites[config.rewrites.length - 1], spaRewrites[0])
})

test('A4 workspace rewrites point at the single /api/workspace function, before the SPA fallback, and nothing else is rewritten', () => {
  assert.equal(workspaceRewrites.length, 2, 'one rewrite for /api/<family> and one for /api/<family>/...')
  for (const rule of workspaceRewrites) {
    assert.equal(rule.destination, '/api/workspace')
    assert.ok(config.rewrites.indexOf(rule) < config.rewrites.indexOf(spaRewrites[0]), `${rule.source} must come before the SPA fallback`)
    assert.match(rule.source, /^\/api\/:__vf\(projects\|conversations\|saved\|library\)(\/:__vp\*)?$/)
  }
  assert.equal(config.rewrites.length, workspaceRewrites.length + spaRewrites.length, 'only the workspace rewrites and the SPA fallback exist')
})

test('client-side routes fall back to index.html', () => {
  const rewritten = rewriteMatcher(spaConfig)
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
  const rewritten = rewriteMatcher(spaConfig)
  for (const path of [
    '/assets/index-AbC123.js', '/assets/index-AbC123.css', '/assets/nested/chunk-1.js', '/assets/font.woff2',
    '/favicon.ico', '/robots.txt', '/vite.svg', '/index.html',
    '/api/auth/session', '/api/auth/signin', '/api/user/profile', '/api/user/settings',
    // the A4 API URLs are served by the workspace function and must never be swallowed by the SPA fallback
    '/api/projects', '/api/projects/3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b', '/api/conversations',
    '/api/conversations/3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b/messages', '/api/saved', '/api/library',
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
