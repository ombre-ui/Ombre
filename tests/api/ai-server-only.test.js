import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// A5.1 S4: AI code is server-only. It lives under api/_lib/ai (an underscore path, so never a deployable
// function), is never imported by the browser bundle, holds no credential and makes no network call (S4-A has no
// real provider).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AI_DIR = join(ROOT, 'api', '_lib', 'ai')
const SOURCE_EXT = /\.(?:[cm]?jsx?|tsx?)$/

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

// Files under `dir` that mention server-only AI code or the trusted prompt sources.
export function findServerOnlyReferences(dir) {
  const FORBIDDEN = /api\/_lib\/ai|_lib\/ai\/|mentor-prompts|mentorPromptsData/
  return walk(dir)
    .filter((file) => SOURCE_EXT.test(file))
    .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')))
    .map((file) => relative(dir, file))
}

test('nothing under src/ references server-only AI code or the mentor prompt sources', () => {
  assert.ok(existsSync(join(ROOT, 'src')), 'src/ exists')
  assert.deepEqual(findServerOnlyReferences(join(ROOT, 'src')), [])
})

test('the scanner itself flags a forbidden reference (so the check above cannot pass vacuously)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'src-scan-'))
  try {
    mkdirSync(join(dir, 'features'), { recursive: true })
    writeFileSync(join(dir, 'features', 'ok.jsx'), "import x from './x.js'\n")
    writeFileSync(join(dir, 'features', 'bad1.js'), "import { createFakeProvider } from '../../api/_lib/ai/providers/fake.js'\n")
    writeFileSync(join(dir, 'features', 'bad2.jsx'), "const p = '/mentor-prompts/startup-validator.md'\n")
    writeFileSync(join(dir, 'features', 'bad3.js'), "import data from '../x/mentorPromptsData.js'\n")
    assert.deepEqual(findServerOnlyReferences(dir).sort(), ['features/bad1.js', 'features/bad2.jsx', 'features/bad3.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AI code lives only under api/_lib/ai, an underscore path that is never a deployable Vercel function', () => {
  assert.ok(existsSync(AI_DIR))
  const files = walk(AI_DIR).map((f) => relative(ROOT, f).split('\\').join('/'))
  assert.ok(files.length > 0)
  for (const file of files) {
    assert.ok(file.startsWith('api/_lib/ai/'), file)
    assert.ok(file.split('/').some((segment) => segment.startsWith('_')), `${file} has an underscore segment`)
  }
})

test('S4-A AI modules read no environment (only config.js takes an env object) and open no network connection', () => {
  const files = walk(AI_DIR).filter((f) => SOURCE_EXT.test(f))
  assert.ok(files.length >= 3)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const name = relative(ROOT, file).split('\\').join('/')
    assert.ok(!/\bprocess\.env\b/.test(text.replace(/^\s*\/\/.*$/gm, '')) || name.endsWith('/config.js'), `${name} must not read process.env`)
    assert.ok(!/\bfetch\s*\(/.test(text), `${name} must not call fetch`)
    assert.ok(!/node:(?:https?|net|tls|dgram|http2)\b|XMLHttpRequest|WebSocket/.test(text), `${name} must not open a network connection`)
    assert.ok(!/\b(?:sk-|nvapi-|sb_secret_)[A-Za-z0-9_-]{8,}/.test(text), `${name} must not contain a credential`)
  }
  assert.ok(statSync(AI_DIR).isDirectory())
})
