// Run after `npm run build` (npm run check:dist). Proves the built entry points are real JS/CSS files that the
// SPA rewrite in vercel.json does not touch, so Vercel serves them as scripts/styles instead of index.html.
//  - every /assets/... URL referenced by dist/index.html exists in dist/
//  - each is a .js/.mjs/.css file whose bytes are not HTML
//  - none of them matches the vercel.json SPA rewrite source (so they can never be rewritten to /index.html)
//  - the expected Content-Type is derived from the extension and reported
import { existsSync, readFileSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' }

export function rewriteMatcher(vercelConfig) {
  const rewrites = vercelConfig.rewrites || []
  const regexes = rewrites.map((r) => new RegExp('^(?:' + r.source + ')$'))
  return (path) => regexes.some((re) => re.test(path))
}

export function assetRefs(indexHtml) {
  const refs = new Set()
  for (const m of indexHtml.matchAll(/(?:src|href)\s*=\s*["'](\/assets\/[^"'?#]+)["']/g)) refs.add(m[1])
  return [...refs]
}

export function checkDist(distDir, vercelConfig) {
  const problems = []
  const report = []
  const indexPath = join(distDir, 'index.html')
  if (!existsSync(indexPath)) return { problems: [`${indexPath} is missing; run npm run build first`], report }
  const refs = assetRefs(readFileSync(indexPath, 'utf8'))
  if (refs.length === 0) problems.push('dist/index.html references no /assets/ files')
  const rewritten = rewriteMatcher(vercelConfig)
  for (const ref of refs) {
    const file = join(distDir, ref)
    const ext = extname(ref)
    if (!MIME[ext]) problems.push(`${ref}: unexpected asset type "${ext}"`)
    if (!existsSync(file)) {
      problems.push(`${ref}: not present in the build output`)
      continue
    }
    const head = readFileSync(file, 'utf8').slice(0, 200).trimStart().toLowerCase()
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) problems.push(`${ref}: file content is HTML`)
    if (rewritten(ref)) problems.push(`${ref}: matches the SPA rewrite in vercel.json and could be served as index.html`)
    report.push(`${ref} -> ${MIME[ext] || 'unknown'}`)
  }
  return { problems, report }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const distDir = resolve(process.argv[2] || 'dist')
  const config = JSON.parse(readFileSync(resolve(process.argv[3] || 'vercel.json'), 'utf8'))
  const { problems, report } = checkDist(distDir, config)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(report.join('\n'))
  console.log('dist asset check passed')
}
