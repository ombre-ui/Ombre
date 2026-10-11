// Static wiring checks for src/ (run by `npm test`). They catch the kind of breakage a refactor leaves behind
// without needing a browser:
//  1. every relative import resolves to a real file
//  2. nothing destructures a retired API from useOmbreData() (profile/settings/theme/clear-all moved to useUserState)
//  3. nothing still imports the retired makeProfile
//  4. every page that shows session-only or demo data renders a <PreviewNotice>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const RETIRED_STORE_API = ['getProfile', 'updateProfile', 'getSettings', 'updateSettings', 'theme', 'toggleTheme', 'clearAllConversations', 'clearAllMemory']

// Pages that display data held only in memory (or demo output) and must say so.
export const NOTICE_REQUIRED = [
  'features/projects/ProjectsOverviewPage.jsx',
  'features/projects/ProjectWorkspacePage.jsx',
  'features/memory/MemoryPage.jsx',
  'features/history/HistoryPage.jsx',
  'features/library/LibraryPage.jsx',
  'features/general-ai/EmptyStart.jsx',
  'features/general-ai/ConversationView.jsx',
]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(js|jsx|mjs)$/.test(name)) yield full
  }
}

export function checkImports(file, text) {
  const problems = []
  for (const m of text.matchAll(/(?:from\s+|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), m[1])
    if (!existsSync(target)) problems.push(`${file}: import "${m[1]}" does not resolve`)
  }
  return problems
}

export function checkRetiredStoreApi(file, text) {
  const problems = []
  for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*useOmbreData\(\)/g)) {
    const names = m[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean)
    for (const name of names) {
      if (RETIRED_STORE_API.includes(name)) problems.push(`${file}: "${name}" is no longer provided by useOmbreData (use useUserState)`)
    }
  }
  if (/\bmakeProfile\b/.test(text)) problems.push(`${file}: makeProfile was retired`)
  return problems
}

export function run(dir) {
  const problems = []
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8')
    problems.push(...checkImports(file, text), ...checkRetiredStoreApi(file, text))
  }
  for (const rel of NOTICE_REQUIRED) {
    const file = join(dir, rel)
    if (!existsSync(file)) {
      problems.push(`${file}: expected page is missing`)
    } else if (!/<PreviewNotice\b/.test(readFileSync(file, 'utf8'))) {
      problems.push(`${file}: shows session-only or demo data but renders no <PreviewNotice>`)
    }
  }
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = run(resolve(process.argv[2] || 'src'))
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('ui wiring check passed')
}
