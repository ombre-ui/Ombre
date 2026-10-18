// Fails if the browser code stores anything it shouldn't. Run by `npm test`.
//  - sessionStorage / indexedDB / document.cookie are forbidden in src/
//  - localStorage may only use the two approved UI keys (theme cache, sidebar state)
//  - the retired mock-data key may only be *removed* (one-time cleanup), never read or written
//  - src/ must never import @supabase/* (the browser never talks to Supabase)
//  - the mock/demo store (src/lib/store.jsx) must not persist anything
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] || 'src')
const ALLOWED_KEYS = new Set(['ombre-theme', 'ombre-sidebar-collapsed'])
const LEGACY_PURGE_KEYS = new Set(['ombre-mock-data-v1'])
const LEGACY_PURGE_FILE = join('lib', 'auth', 'localData.js')

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(js|jsx|ts|tsx|mjs)$/.test(name)) yield full
  }
}

export function scanSource(file, text) {
  const problems = []
  if (/\bsessionStorage\b/.test(text)) problems.push(`${file}: sessionStorage is not allowed`)
  if (/\bindexedDB\b/.test(text)) problems.push(`${file}: indexedDB is not allowed`)
  if (/document\.cookie/.test(text)) problems.push(`${file}: document.cookie is not allowed`)
  if (/from\s+['"]@supabase\//.test(text) || /require\(['"]@supabase\//.test(text)) problems.push(`${file}: @supabase/* must not be imported in src/`)
  if (/\bimport\.meta\.env\.VITE_[A-Z_]*(SUPABASE|SECRET|SERVICE|KEY)/.test(text)) problems.push(`${file}: secrets must not use VITE_ variables`)

  // Constants naming a storage key. A constant holding a legacy key may only be used with removeItem.
  const legacyConstants = new Set()
  for (const m of text.matchAll(/(?:const|let)\s+([A-Z_]*(?:STORAGE_KEY|KEY))\s*=\s*['"]([^'"]+)['"]/g)) {
    if (LEGACY_PURGE_KEYS.has(m[2])) legacyConstants.add(m[1])
    else if (/localStorage/.test(text) && !ALLOWED_KEYS.has(m[2])) problems.push(`${file}: storage key constant ${m[1]}="${m[2]}" is not approved`)
  }

  for (const m of text.matchAll(/localStorage\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*([^,)]+)/g)) {
    const method = m[1]
    const arg = m[2].trim()
    const literal = arg.match(/^['"]([^'"]+)['"]$/)
    if (literal) {
      const key = literal[1]
      if (ALLOWED_KEYS.has(key)) continue
      if (LEGACY_PURGE_KEYS.has(key) && method === 'removeItem') continue
      problems.push(`${file}: localStorage key "${key}" is not approved${LEGACY_PURGE_KEYS.has(key) ? ' for ' + method + ' (removeItem only)' : ''}`)
    } else if (/^[A-Z_]+$/.test(arg)) {
      if (legacyConstants.has(arg) && method !== 'removeItem') problems.push(`${file}: the retired key ${arg} may only be removed, not ${method}`)
    } else {
      problems.push(`${file}: localStorage key must be a literal or an ALL_CAPS constant (${arg})`)
    }
  }
  return problems
}

export function run(dir) {
  const problems = []
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8')
    problems.push(...scanSource(file, text))
    // The retired key's name may appear only in the one file that cleans it up.
    const mentionsLegacy = [...LEGACY_PURGE_KEYS].some((key) => text.includes(key))
    if (mentionsLegacy && !file.endsWith(sep + LEGACY_PURGE_FILE) && !file.endsWith('/' + LEGACY_PURGE_FILE)) {
      problems.push(`${file}: the retired mock-data key may only be referenced in src/${LEGACY_PURGE_FILE.split(sep).join('/')}`)
    }
  }
  try {
    const store = readFileSync(join(dir, 'lib/store.jsx'), 'utf8')
    if (/localStorage|sessionStorage|indexedDB/.test(store) || /STORAGE_KEY/.test(store)) {
      problems.push('src/lib/store.jsx must not persist anything (it is session-only demo state)')
    }
  } catch (e) {
    problems.push(`could not inspect src/lib/store.jsx: ${e.message}`)
  }
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = run(root)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('browser storage check passed')
}
