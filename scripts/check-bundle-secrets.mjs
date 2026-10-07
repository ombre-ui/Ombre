// Fails the build if the production bundle contains anything that must stay server-side. Runs as `postbuild`.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g

export function scanBundleText(file, text, env = {}) {
  const problems = []
  if (/sb_secret_[A-Za-z0-9_-]+/.test(text)) problems.push(`${file}: contains a Supabase secret key`)
  if (/service_role/.test(text)) problems.push(`${file}: mentions service_role`)
  if (/SUPABASE_(SERVICE|JWT|SECRET)/.test(text)) problems.push(`${file}: references a server-only Supabase variable`)
  if (/@supabase\/(ssr|supabase-js)/.test(text)) problems.push(`${file}: bundles a Supabase library (the browser must not talk to Supabase)`)
  if (/\.supabase\.co/.test(text)) problems.push(`${file}: contains a supabase.co URL`)
  if (/sb_publishable_[A-Za-z0-9_-]+/.test(text)) problems.push(`${file}: contains a Supabase publishable key (not needed in the browser)`)
  for (const m of text.matchAll(JWT)) {
    try {
      const payload = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString('utf8'))
      if (payload && (payload.role === 'service_role' || payload.role === 'anon' || payload.iss === 'supabase')) problems.push(`${file}: contains a Supabase JWT (role=${payload.role})`)
    } catch {
      // not a JWT
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 16 && text.includes(value)) problems.push(`${file}: contains the value of ${name}`)
  }
  if (/__Host-ombre-auth|ombre-auth/.test(text)) problems.push(`${file}: references the auth cookie name (cookies are server-only)`)
  return problems
}

export function scanDist(dir, env) {
  const problems = []
  for (const file of walk(dir)) {
    if (!/\.(js|mjs|css|html|map|json|txt)$/.test(file)) continue
    problems.push(...scanBundleText(file, readFileSync(file, 'utf8'), env))
  }
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dist = resolve(process.argv[2] || 'dist')
  if (!existsSync(dist)) {
    console.error(`bundle check: ${dist} does not exist`)
    process.exit(1)
  }
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY }
  const problems = scanDist(dist, env)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('bundle secret check passed')
}
