import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// A5.0 guard: the Vercel Hobby plan allows at most 12 serverless functions per deployment. A4 hit that limit
// (exceeded_serverless_functions_per_deployment) and was fixed by packaging, so every future AI route must go
// through the existing api/workspace.js dispatcher instead of adding a new api/*.js file.
//
// A file under api/ is a deployable function when its extension is one of EXTENSIONS and no path segment (file or
// directory name) begins with "_" (api/_lib/** and any _-prefixed file are helpers, not functions).

export const MAX_FUNCTIONS = 12
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])

// Pinned inventory. Adding, removing or renaming an API file must be a deliberate edit of this list.
export const EXPECTED_FUNCTIONS = [
  'api/auth/callback.js',
  'api/auth/forgot-password.js',
  'api/auth/oauth.js',
  'api/auth/reset-code.js',
  'api/auth/reset-password.js',
  'api/auth/session.js',
  'api/auth/signin.js',
  'api/auth/signout.js',
  'api/auth/signup.js',
  'api/user/profile.js',
  'api/user/settings.js',
  'api/workspace.js',
]

// Returns the sorted, repo-relative ("api/...", forward slashes) paths of every deployable function under apiDir.
// Symlinked directories are not followed (no loops); symlinked files are counted if they point at a file.
export function listApiFunctions(apiDir) {
  const found = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_')) continue
      const abs = join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        isDir = false
        isFile = statSync(abs).isFile()
      }
      if (isDir) walk(abs, relPath)
      else if (isFile && EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(`api/${relPath}`)
    }
  }
  walk(apiDir, '')
  return found.sort()
}

export function diffInventory(found, expected) {
  const foundSet = new Set(found)
  const expectedSet = new Set(expected)
  return {
    missing: expected.filter((f) => !foundSet.has(f)).sort(),
    unexpected: found.filter((f) => !expectedSet.has(f)).sort(),
  }
}

function countMessage(found, max) {
  return `API function count is ${found.length}, limit is ${max}. Deployable files:\n  ${found.join('\n  ')}\n` +
    'Do not add a new api/*.js route: route new work through api/workspace.js.'
}

function inventoryMessage({ missing, unexpected }) {
  const lines = ['API function inventory differs from the pinned A5.0 list.']
  if (unexpected.length) lines.push(`Unexpected (present, not pinned):\n  ${unexpected.join('\n  ')}`)
  if (missing.length) lines.push(`Missing (pinned, not present):\n  ${missing.join('\n  ')}`)
  return lines.join('\n')
}

const REPO_API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'api')

// --- The real repository -------------------------------------------------------------------------------------

test('the pinned inventory is itself exactly 12 unique, sorted entries', () => {
  assert.equal(EXPECTED_FUNCTIONS.length, MAX_FUNCTIONS)
  assert.equal(new Set(EXPECTED_FUNCTIONS).size, EXPECTED_FUNCTIONS.length, 'no duplicates')
  assert.deepEqual([...EXPECTED_FUNCTIONS].sort(), EXPECTED_FUNCTIONS)
})

test('api/ contains no more than 12 deployable functions', () => {
  const found = listApiFunctions(REPO_API_DIR)
  assert.ok(found.length <= MAX_FUNCTIONS, countMessage(found, MAX_FUNCTIONS))
})

test('api/ contains exactly the 12 pinned deployable functions', () => {
  const found = listApiFunctions(REPO_API_DIR)
  const diff = diffInventory(found, EXPECTED_FUNCTIONS)
  assert.ok(diff.missing.length === 0 && diff.unexpected.length === 0, inventoryMessage(diff))
})

// --- The guard logic, exercised on throwaway trees (never touches the real api/) --------------------------------

function fakeApi(extraFiles = []) {
  const root = mkdtempSync(join(tmpdir(), 'api-guard-'))
  for (const rel of [...EXPECTED_FUNCTIONS, ...extraFiles]) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, '// fixture\n')
  }
  return { root, apiDir: join(root, 'api'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('guard logic: a tree matching the pinned inventory passes both checks', () => {
  const t = fakeApi()
  try {
    const found = listApiFunctions(t.apiDir)
    assert.deepEqual(found, EXPECTED_FUNCTIONS)
    assert.deepEqual(diffInventory(found, EXPECTED_FUNCTIONS), { missing: [], unexpected: [] })
    assert.ok(found.length <= MAX_FUNCTIONS)
  } finally { t.cleanup() }
})

test('guard logic: an unexpected api/zz.js is detected, reported by name, and exceeds the limit', () => {
  const t = fakeApi(['api/zz.js'])
  try {
    const found = listApiFunctions(t.apiDir)
    assert.equal(found.length, MAX_FUNCTIONS + 1)
    assert.ok(found.length > MAX_FUNCTIONS)
    const diff = diffInventory(found, EXPECTED_FUNCTIONS)
    assert.deepEqual(diff, { missing: [], unexpected: ['api/zz.js'] })
    assert.match(inventoryMessage(diff), /Unexpected[\s\S]*api\/zz\.js/)
    assert.match(countMessage(found, MAX_FUNCTIONS), /count is 13, limit is 12/)
  } finally { t.cleanup() }
})

test('guard logic: a missing pinned file is reported as missing', () => {
  const t = fakeApi()
  try {
    rmSync(join(t.apiDir, 'user', 'settings.js'))
    const diff = diffInventory(listApiFunctions(t.apiDir), EXPECTED_FUNCTIONS)
    assert.deepEqual(diff, { missing: ['api/user/settings.js'], unexpected: [] })
    assert.match(inventoryMessage(diff), /Missing[\s\S]*api\/user\/settings\.js/)
  } finally { t.cleanup() }
})

test('guard logic: a renamed file shows as one missing plus one unexpected', () => {
  const t = fakeApi(['api/auth/signup2.js'])
  try {
    rmSync(join(t.apiDir, 'auth', 'signup.js'))
    assert.deepEqual(diffInventory(listApiFunctions(t.apiDir), EXPECTED_FUNCTIONS), {
      missing: ['api/auth/signup.js'],
      unexpected: ['api/auth/signup2.js'],
    })
  } finally { t.cleanup() }
})

test('guard logic: every deployable extension is counted, including in new nested directories', () => {
  const extras = ['a.js', 'b.mjs', 'c.cjs', 'd.ts', 'e.mts', 'f.cts'].map((n) => `api/new/deep/${n}`)
  const t = fakeApi(extras)
  try {
    assert.deepEqual(diffInventory(listApiFunctions(t.apiDir), EXPECTED_FUNCTIONS).unexpected, extras.sort())
  } finally { t.cleanup() }
})

test('guard logic: any path segment starting with "_" is ignored, files and directories alike', () => {
  const t = fakeApi([
    'api/_lib/helper.js', 'api/_lib/deep/more.ts', 'api/_private.js', 'api/auth/_shared.js', 'api/user/_x/y.mjs',
  ])
  try {
    assert.deepEqual(listApiFunctions(t.apiDir), EXPECTED_FUNCTIONS)
  } finally { t.cleanup() }
})

test('guard logic: non-code files do not count as functions', () => {
  const t = fakeApi(['api/README.md', 'api/auth/notes.txt', 'api/data.json', 'api/auth/style.css', 'api/noext'])
  try {
    assert.deepEqual(listApiFunctions(t.apiDir), EXPECTED_FUNCTIONS)
  } finally { t.cleanup() }
})
