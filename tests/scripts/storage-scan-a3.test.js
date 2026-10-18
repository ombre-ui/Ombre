import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSource, run } from '../../scripts/check-browser-storage.mjs'

test('only the two approved keys are accepted; the retired mock key is no longer approved', () => {
  assert.deepEqual(scanSource('a.jsx', "window.localStorage.getItem('ombre-theme'); window.localStorage.setItem('ombre-sidebar-collapsed', 'x')"), [])
  assert.equal(scanSource('a.jsx', "localStorage.setItem('ombre-mock-data-v1', x)").length, 1)
  assert.equal(scanSource('a.jsx', "localStorage.getItem('ombre-mock-data-v1')").length, 1)
  assert.equal(scanSource('a.jsx', "localStorage.setItem('anything-else', x)").length, 1)
})

test('the retired mock key may be removed (cleanup), by literal or by constant, but never read or written', () => {
  assert.deepEqual(scanSource('a.js', "window.localStorage.removeItem('ombre-mock-data-v1')"), [])
  assert.deepEqual(scanSource('a.js', "const LEGACY_MOCK_DATA_KEY = 'ombre-mock-data-v1'\nwindow.localStorage.removeItem(LEGACY_MOCK_DATA_KEY)"), [])
  assert.equal(scanSource('a.js', "const LEGACY_MOCK_DATA_KEY = 'ombre-mock-data-v1'\nwindow.localStorage.setItem(LEGACY_MOCK_DATA_KEY, 'x')").length, 1)
  assert.equal(scanSource('a.js', "const LEGACY_MOCK_DATA_KEY = 'ombre-mock-data-v1'\nwindow.localStorage.getItem(LEGACY_MOCK_DATA_KEY)").length, 1)
})

test('an unapproved key constant is still flagged', () => {
  assert.equal(scanSource('a.js', "const SOME_KEY = 'token'\nlocalStorage.getItem(SOME_KEY)").length, 1)
})

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'src-'))
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return dir
}

test('run(): clean tree passes; legacy key allowed only in lib/auth/localData.js', () => {
  const clean = tree({
    'lib/store.jsx': 'export const x = 1',
    'lib/auth/localData.js': "const LEGACY_MOCK_DATA_KEY = 'ombre-mock-data-v1'\nwindow.localStorage.removeItem(LEGACY_MOCK_DATA_KEY)",
    'lib/theme.js': "const THEME_CACHE_KEY = 'ombre-theme'\nwindow.localStorage.getItem(THEME_CACHE_KEY)",
  })
  assert.deepEqual(run(clean), [])
  const elsewhere = tree({
    'lib/store.jsx': 'export const x = 1',
    'lib/other.js': "window.localStorage.removeItem('ombre-mock-data-v1')",
  })
  assert.equal(run(elsewhere).length, 1)
})

test('run(): the demo store must not persist anything', () => {
  for (const body of ["window.localStorage.setItem('ombre-theme', 'x')", "const STORAGE_KEY = 'x'", 'indexedDB.open("x")']) {
    assert.ok(run(tree({ 'lib/store.jsx': body })).some((p) => /must not persist/.test(p)), body)
  }
  assert.ok(run(tree({ 'lib/other.js': 'x' })).some((p) => /could not inspect/.test(p)))
})
