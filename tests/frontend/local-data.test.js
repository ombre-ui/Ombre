import test from 'node:test'
import assert from 'node:assert/strict'

function installWindow() {
  const store = new Map([['ombre-mock-data-v1', '{"conversations":{"c":1}}'], ['ombre-theme', 'dark']])
  const listeners = {}
  const nav = []
  globalThis.window = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
    location: { replace: (p) => nav.push(p) },
  }
  return { store, listeners, nav }
}

test('wipeAndNavigate removes only the mock data key, hard-navigates, and wipes again on pagehide', async () => {
  const env = installWindow()
  const { wipeAndNavigate, MOCK_DATA_STORAGE_KEY } = await import('../../src/lib/auth/localData.js')
  assert.equal(MOCK_DATA_STORAGE_KEY, 'ombre-mock-data-v1')
  wipeAndNavigate('/login')
  assert.equal(env.store.has('ombre-mock-data-v1'), false)
  assert.equal(env.store.get('ombre-theme'), 'dark') // UI preference survives
  assert.deepEqual(env.nav, ['/login'])
  // a late re-persist (e.g. a pending mock reply) is wiped at unload
  env.store.set('ombre-mock-data-v1', 'late')
  env.listeners.pagehide.forEach((fn) => fn())
  assert.equal(env.store.has('ombre-mock-data-v1'), false)
})

test('wipeMockData tolerates unavailable storage', async () => {
  globalThis.window = { localStorage: { removeItem: () => { throw new Error('denied') } } }
  const { wipeMockData } = await import('../../src/lib/auth/localData.js')
  assert.doesNotThrow(() => wipeMockData())
})
