import test from 'node:test'
import assert from 'node:assert/strict'

function installWindow({ throwing = false } = {}) {
  const store = new Map([['ombre-mock-data-v1', '{"conversations":{"c":1}}'], ['ombre-theme', 'dark'], ['ombre-sidebar-collapsed', 'true']])
  const listeners = {}
  const nav = []
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => { if (throwing) throw new Error('denied'); store.delete(k) },
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
    location: { replace: (p) => nav.push(p) },
  }
  return { store, listeners, nav }
}

test('purgeLegacyLocalData removes only the retired mock key', async () => {
  const env = installWindow()
  const { purgeLegacyLocalData, LEGACY_MOCK_DATA_KEY } = await import('../../src/lib/auth/localData.js')
  assert.equal(LEGACY_MOCK_DATA_KEY, 'ombre-mock-data-v1')
  purgeLegacyLocalData()
  assert.equal(env.store.has('ombre-mock-data-v1'), false)
  assert.equal(env.store.get('ombre-theme'), 'dark') // UI cache survives
  assert.equal(env.store.get('ombre-sidebar-collapsed'), 'true')
})

test('wipeAndNavigate purges the legacy key and hard-navigates; no unload listeners are needed any more', async () => {
  const env = installWindow()
  const { wipeAndNavigate } = await import('../../src/lib/auth/localData.js')
  wipeAndNavigate('/login')
  assert.equal(env.store.has('ombre-mock-data-v1'), false)
  assert.deepEqual(env.nav, ['/login'])
  assert.deepEqual(Object.keys(env.listeners), [])
})

test('purgeLegacyLocalData tolerates unavailable storage', async () => {
  installWindow({ throwing: true })
  const { purgeLegacyLocalData } = await import('../../src/lib/auth/localData.js')
  assert.doesNotThrow(() => purgeLegacyLocalData())
})
