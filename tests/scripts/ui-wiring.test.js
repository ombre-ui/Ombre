import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkImports, checkRetiredStoreApi, run, NOTICE_REQUIRED } from '../../scripts/check-ui-wiring.mjs'

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-'))
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return dir
}

test('checkImports flags unresolved relative imports only', () => {
  const dir = tree({ 'a/b.js': 'export {}', 'a/c.css': '' })
  const file = join(dir, 'a/x.jsx')
  assert.deepEqual(checkImports(file, "import b from './b.js'\nimport './c.css'\nimport React from 'react'\nexport { y } from '../a/b.js'"), [])
  const bad = checkImports(file, "import m from './missing.jsx'\nimport './nope.css'")
  assert.equal(bad.length, 2)
})

test('checkRetiredStoreApi flags retired useOmbreData members, including aliased ones', () => {
  assert.deepEqual(checkRetiredStoreApi('f.jsx', 'const { listProjects, createProject } = useOmbreData()'), [])
  assert.equal(checkRetiredStoreApi('f.jsx', 'const { getProfile, listConversations } = useOmbreData()').length, 1)
  assert.equal(checkRetiredStoreApi('f.jsx', 'const { theme: t, toggleTheme } = useOmbreData()').length, 2)
  assert.equal(checkRetiredStoreApi('f.jsx', 'const { clearAllMemory,\n updateSettings } = useOmbreData()').length, 2)
  assert.equal(checkRetiredStoreApi('f.jsx', "import { makeProfile } from './types.js'").length, 1)
  // the same names from useUserState are fine
  assert.deepEqual(checkRetiredStoreApi('f.jsx', 'const { updateSettings, theme } = useUserState()'), [])
})

test('run(): a complete tree passes; a missing notice or a broken import fails', () => {
  const ok = {}
  for (const rel of NOTICE_REQUIRED) ok[rel] = "import PreviewNotice from '../../layout/PreviewNotice.jsx'\nexport default () => <PreviewNotice />"
  ok['layout/PreviewNotice.jsx'] = 'export default () => null'
  assert.deepEqual(run(tree(ok)), [])

  const noNotice = { ...ok, 'features/library/LibraryPage.jsx': "import PreviewNotice from '../../layout/PreviewNotice.jsx'\nexport default () => null" }
  const missing = run(tree(noNotice))
  assert.equal(missing.length, 1)
  assert.match(missing[0], /LibraryPage\.jsx.*no <PreviewNotice>/)

  const broken = run(tree({ ...ok, 'features/memory/MemoryPage.jsx': "import PreviewNotice from '../../layout/Gone.jsx'\nexport default () => <PreviewNotice />" }))
  assert.equal(broken.length, 1)
  assert.match(broken[0], /does not resolve/)

  const absent = { ...ok }
  delete absent['features/history/HistoryPage.jsx']
  assert.ok(run(tree(absent)).some((p) => /expected page is missing/.test(p)))
})
