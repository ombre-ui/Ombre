import test from 'node:test'
import assert from 'node:assert/strict'

function installDom({ stored, dark = false, throwing = false } = {}) {
  const store = new Map(stored === undefined ? [] : [['ombre-theme', stored]])
  const attrs = {}
  const listeners = new Set()
  globalThis.document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v } } }
  globalThis.window = {
    localStorage: {
      getItem: (k) => { if (throwing) throw new Error('denied'); return store.has(k) ? store.get(k) : null },
      setItem: (k, v) => { if (throwing) throw new Error('denied'); store.set(k, v) },
    },
    matchMedia: () => ({
      matches: dark,
      addEventListener: (_t, fn) => listeners.add(fn),
      removeEventListener: (_t, fn) => listeners.delete(fn),
    }),
  }
  return { store, attrs, listeners }
}

const theme = await import('../../src/lib/theme.js')

test('readCachedTheme accepts only system|light|dark; anything else falls back to system', () => {
  for (const good of ['system', 'light', 'dark']) {
    installDom({ stored: good })
    assert.equal(theme.readCachedTheme(), good)
  }
  for (const bad of ['', 'DARK', 'blue', '<script>', 'null', '{"a":1}', 'light ']) {
    installDom({ stored: bad })
    assert.equal(theme.readCachedTheme(), 'system', JSON.stringify(bad))
  }
  installDom()
  assert.equal(theme.readCachedTheme(), 'system')
  installDom({ throwing: true })
  assert.equal(theme.readCachedTheme(), 'system')
})

test('cacheTheme writes only valid preferences and tolerates unavailable storage', () => {
  const env = installDom()
  theme.cacheTheme('dark')
  assert.equal(env.store.get('ombre-theme'), 'dark')
  theme.cacheTheme('purple')
  theme.cacheTheme(undefined)
  theme.cacheTheme({})
  assert.equal(env.store.get('ombre-theme'), 'dark')
  installDom({ throwing: true })
  assert.doesNotThrow(() => theme.cacheTheme('light'))
})

test("resolveTheme: explicit values win; 'system' follows the OS", () => {
  assert.equal(theme.resolveTheme('dark', false), 'dark')
  assert.equal(theme.resolveTheme('light', true), 'light')
  assert.equal(theme.resolveTheme('system', true), 'dark')
  assert.equal(theme.resolveTheme('system', false), 'light')
  assert.equal(theme.resolveTheme('garbage', true), 'dark') // invalid input behaves like system
  installDom({ dark: true })
  assert.equal(theme.resolveTheme('system'), 'dark')
})

test('applyTheme only ever writes light or dark to the DOM', () => {
  const env = installDom()
  theme.applyTheme('dark')
  assert.equal(env.attrs['data-theme'], 'dark')
  theme.applyTheme('system')
  assert.equal(env.attrs['data-theme'], 'light')
  theme.applyTheme('<img onerror=x>')
  assert.equal(env.attrs['data-theme'], 'light')
})

test('initTheme applies the cached preference before any network: system+dark OS => dark, cached light => light', () => {
  let env = installDom({ stored: 'system', dark: true })
  theme.initTheme()
  assert.equal(env.attrs['data-theme'], 'dark')
  env = installDom({ stored: 'light', dark: true })
  theme.initTheme()
  assert.equal(env.attrs['data-theme'], 'light')
  env = installDom({ stored: 'junk', dark: false })
  theme.initTheme()
  assert.equal(env.attrs['data-theme'], 'light')
})

test('watchSystemTheme reports OS changes and unsubscribes', () => {
  const env = installDom()
  const seen = []
  const stop = theme.watchSystemTheme((dark) => seen.push(dark))
  assert.equal(env.listeners.size, 1)
  env.listeners.forEach((fn) => fn({ matches: true }))
  assert.deepEqual(seen, [true])
  stop()
  assert.equal(env.listeners.size, 0)
})
