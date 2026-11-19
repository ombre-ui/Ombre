import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkspace, ok } from './workspace-helpers.js'
import { createFakeProvider } from '../../api/_lib/ai/providers/fake.js'

const NINE_ROUTES = [
  'projectsIndex', 'projectById', 'conversationsIndex', 'conversationById', 'conversationMessages',
  'savedIndex', 'savedById', 'libraryIndex', 'libraryById',
]
const handler = async () => ok([])

test('buildWorkspace without an ai option behaves as before: no ai, the nine routes and the dispatcher', () => {
  const workspace = buildWorkspace({ handler })
  assert.equal(workspace.ai, undefined)
  for (const name of NINE_ROUTES) assert.equal(typeof workspace.routes[name], 'function', name)
  assert.equal(typeof workspace.routes.workspace, 'function')
  assert.ok(Array.isArray(workspace.lines))
  assert.ok(Array.isArray(workspace.calls))
})

test('buildWorkspace hands back the injected AI runtime by identity', () => {
  const provider = createFakeProvider()
  const ai = { getRuntime: () => ({ provider }) }
  const workspace = buildWorkspace({ handler, ai })
  assert.equal(workspace.ai, ai)
  assert.equal(workspace.ai.getRuntime().provider, provider)
})

test('injecting ai does not change the set of routes', () => {
  const without = Object.keys(buildWorkspace({ handler }).routes).sort()
  const withAi = Object.keys(buildWorkspace({ handler, ai: { getRuntime: () => ({}) } }).routes).sort()
  assert.deepEqual(withAi, without)
})
