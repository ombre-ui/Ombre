// Fails if the browser code stores anything it shouldn't. Run by `npm test`.
//  - sessionStorage / indexedDB / document.cookie are forbidden in src/
//  - localStorage may only use the three approved keys
//  - src/ must never import @supabase/* (the browser never talks to Supabase)
//  - the wipe key in src/lib/auth/localData.js must equal STORAGE_KEY in src/lib/store.jsx
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] || 'src')
const ALLOWED_KEYS = new Set(['ombre-mock-data-v1', 'ombre-theme', 'ombre-sidebar-collapsed'])

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
  for (const m of text.matchAll(/localStorage\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*([^,)]+)/g)) {
    const arg = m[2].trim()
    const literal = arg.match(/^['"]([^'"]+)['"]$/)
    if (literal) {
      if (!ALLOWED_KEYS.has(literal[1])) problems.push(`${file}: localStorage key "${literal[1]}" is not approved`)
    } else if (!/^[A-Z_]+$/.test(arg)) {
      problems.push(`${file}: localStorage key must be a literal or an ALL_CAPS constant (${arg})`)
    }
  }
  for (const m of text.matchAll(/(?:const|let)\s+([A-Z_]*(?:STORAGE_KEY|KEY))\s*=\s*['"]([^'"]+)['"]/g)) {
    if (/localStorage/.test(text) && !ALLOWED_KEYS.has(m[2])) problems.push(`${file}: storage key constant ${m[1]}="${m[2]}" is not approved`)
  }
  return problems
}

export function run(dir) {
  const problems = []
  for (const file of walk(dir)) problems.push(...scanSource(file, readFileSync(file, 'utf8')))
  try {
    const store = readFileSync(join(dir, 'lib/store.jsx'), 'utf8')
    const wipe = readFileSync(join(dir, 'lib/auth/localData.js'), 'utf8')
    const a = store.match(/STORAGE_KEY\s*=\s*['"]([^'"]+)['"]/)
    const b = wipe.match(/MOCK_DATA_STORAGE_KEY\s*=\s*['"]([^'"]+)['"]/)
    if (!a || !b || a[1] !== b[1]) problems.push('src/lib/auth/localData.js MOCK_DATA_STORAGE_KEY must equal STORAGE_KEY in src/lib/store.jsx')
  } catch (e) {
    problems.push(`could not compare wipe key with store key: ${e.message}`)
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
