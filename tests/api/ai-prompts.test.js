import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { AI_DEFAULTS } from '../../api/_lib/ai/config.js'
import { GENERAL_AI_PROMPT, MENTOR_PROMPT_IDS, PromptError, resolveSystemPrompt } from '../../api/_lib/ai/prompts.js'
import { MENTOR_PROMPTS, MENTOR_PROMPT_SHA256 } from '../../api/_lib/ai/mentorPromptsData.js'
import { MENTOR_IDS } from '../../src/features/mentors/catalogData.js'
import { OUTPUT_FILE, PROMPTS_DIR, buildMentorPromptsModule, main, readMentorPrompts, renderModule } from '../../scripts/build-mentor-prompts.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GENERAL_AI_EXACT =
  'You are Ombre, an AI workspace assistant. Help the user make useful progress on the work they bring to you. Be clear, accurate, thoughtful, and direct. Use the conversation context when relevant. Do not claim to have performed actions or accessed information that you have not actually accessed.'
const codePoints = (s) => Array.from(s).length
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function tempDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

// ------------------------------------------------------------------------------------------ the General AI prompt

test('the General AI prompt is exactly the approved text', () => {
  assert.equal(GENERAL_AI_PROMPT, GENERAL_AI_EXACT)
  assert.equal(resolveSystemPrompt(null), GENERAL_AI_EXACT)
})

// ------------------------------------------------------------------------------------------------ the registry

test('the registry holds exactly the 16 catalog mentor ids, each with a non-blank prompt', () => {
  assert.equal(MENTOR_IDS.size, 16)
  assert.deepEqual([...MENTOR_PROMPT_IDS].sort(), [...MENTOR_IDS].sort())
  assert.deepEqual(Object.keys(MENTOR_PROMPTS).sort(), [...MENTOR_IDS].sort())
  assert.deepEqual(Object.keys(MENTOR_PROMPT_SHA256).sort(), [...MENTOR_IDS].sort())
  for (const id of MENTOR_IDS) {
    assert.equal(typeof MENTOR_PROMPTS[id], 'string', id)
    assert.notEqual(MENTOR_PROMPTS[id].trim(), '', id)
  }
  assert.ok(Object.isFrozen(MENTOR_PROMPTS) && Object.isFrozen(MENTOR_PROMPT_SHA256) && Object.isFrozen(MENTOR_PROMPT_IDS))
})

test('drift: every mentor-prompts/*.md file matches its registry entry exactly, with no extra or missing prompts', () => {
  const files = readdirSync(PROMPTS_DIR).filter((name) => name.endsWith('.md')).sort()
  assert.deepEqual(files.map((name) => name.slice(0, -3)), [...MENTOR_PROMPT_IDS].sort(), 'one source file per registry id')
  for (const name of files) {
    const id = name.slice(0, -3)
    const bytes = readFileSync(join(PROMPTS_DIR, name))
    assert.equal(MENTOR_PROMPTS[id], new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), `${id} text differs from its source`)
    assert.equal(MENTOR_PROMPT_SHA256[id], sha(bytes), `${id} digest differs from its source`)
    assert.equal(sha(Buffer.from(MENTOR_PROMPTS[id], 'utf8')), MENTOR_PROMPT_SHA256[id], `${id} registry text is not the hashed bytes`)
  }
})

test('drift: the committed generated module is byte-for-byte what the generator produces now', () => {
  assert.equal(readFileSync(OUTPUT_FILE, 'utf8'), buildMentorPromptsModule(PROMPTS_DIR))
  assert.equal(main({ args: ['--check'], log: () => {}, error: () => {} }), 0)
})

test('the largest prompt plus one maximum-size message fits the 60,000-character input budget', () => {
  const largest = Math.max(...Object.values(MENTOR_PROMPTS).map(codePoints))
  assert.ok(largest + 8000 <= AI_DEFAULTS.inputCharBudget, `largest prompt is ${largest} code points`)
  assert.ok(codePoints(GENERAL_AI_PROMPT) + 8000 <= AI_DEFAULTS.inputCharBudget)
})

// ------------------------------------------------------------------------------------------------ resolution

test('a mentor conversation gets its own prompt and only that prompt (no General AI text)', () => {
  for (const id of MENTOR_IDS) {
    const prompt = resolveSystemPrompt(id)
    assert.equal(prompt, MENTOR_PROMPTS[id])
    assert.notEqual(prompt, GENERAL_AI_PROMPT)
    assert.ok(!prompt.includes(GENERAL_AI_PROMPT), `${id} must not embed the General AI prompt`)
  }
})

test('unknown or malformed mentor ids fail: no generic mentor and no General AI fallback', () => {
  const bad = [
    undefined, '', ' ', 'nope', 'Startup-Validator', ' startup-validator', 'startup-validator ', 'startup-validator\n',
    'constructor', '__proto__', 'toString', 'hasOwnProperty', 'general', 'general-ai', 'mentor', 'default',
    1, true, {}, [], ['startup-validator'], () => 'startup-validator', Symbol('x'),
  ]
  for (const id of bad) {
    assert.throws(() => resolveSystemPrompt(id), (error) => error instanceof PromptError && error.code === 'unknown_mentor', String(typeof id === 'symbol' ? 'symbol' : JSON.stringify(id)))
  }
})

test('PromptError never contains the offending value', () => {
  try {
    resolveSystemPrompt('SECRET-MENTOR-ID')
    assert.fail('expected an error')
  } catch (error) {
    assert.ok(!error.message.includes('SECRET'))
    assert.ok(!JSON.stringify(error).includes('SECRET'))
  }
})

// ------------------------------------------------------------------------------------------------ the generator

test('generator: text is embedded exactly (CRLF, BOM, no trailing newline, unicode, template syntax, U+2028) and round-trips through import', async () => {
  const awkward = {
    'crlf.md': 'line one\r\nline two\r\n',
    'bom.md': '\uFEFFstarts with a BOM\n',
    'no-newline.md': 'no trailing newline',
    'padded.md': '\n\n  leading and trailing spaces  \n\n\n',
    'syntax.md': 'back`tick ${not.a.template} \\n \\\\ "dq" \'sq\' </script> */ // end',
    'unicode.md': 'e\u0301 \u00e9 \u4e2d\u6587 \u{1F600} \u2028 \u2029 tab\there',
  }
  const dir = tempDir(awkward)
  const out = tempDir()
  try {
    const source = renderModule(readMentorPrompts(dir))
    const file = join(out, 'data.mjs')
    writeFileSync(file, source)
    const imported = await import(pathToFileURL(file).href)
    for (const [name, content] of Object.entries(awkward)) {
      const id = name.slice(0, -3)
      assert.equal(imported.MENTOR_PROMPTS[id], content, `${id} must round-trip exactly`)
      assert.equal(imported.MENTOR_PROMPT_SHA256[id], sha(Buffer.from(content, 'utf8')))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('generator: output is deterministic and independent of file creation order, sorted by id', () => {
  const a = tempDir({ 'zeta.md': 'z', 'alpha.md': 'a', 'mid-one.md': 'm' })
  const b = tempDir()
  for (const [name, content] of [['mid-one.md', 'm'], ['alpha.md', 'a'], ['zeta.md', 'z']]) writeFileSync(join(b, name), content)
  try {
    const first = buildMentorPromptsModule(a)
    assert.equal(first, buildMentorPromptsModule(a))
    assert.equal(first, buildMentorPromptsModule(b))
    assert.deepEqual(readMentorPrompts(a).map((p) => p.id), ['alpha', 'mid-one', 'zeta'])
    assert.ok(first.indexOf('"alpha"') < first.indexOf('"mid-one"') && first.indexOf('"mid-one"') < first.indexOf('"zeta"'))
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('generator: bad inputs fail loudly and never print prompt text', () => {
  const secret = 'SECRET-PROMPT-TEXT'
  const cases = {
    'invalid UTF-8': { 'good.md': 'fine', 'bad.md': Buffer.concat([Buffer.from(secret), Buffer.from([0xff, 0xfe, 0xfd])]) },
    'empty file': { 'empty.md': '' },
    'whitespace-only file': { 'blank.md': ' \n\t\n' },
    'uppercase id': { 'Upper.md': secret },
    'underscore id': { 'snake_case.md': secret },
    'leading dash id': { '-lead.md': secret },
    'empty id': { '.md': secret },
  }
  for (const [name, files] of Object.entries(cases)) {
    const dir = tempDir(files)
    try {
      assert.throws(() => readMentorPrompts(dir), (error) => !error.message.includes(secret), name)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const withSubdir = tempDir({ 'ok.md': 'fine' })
  mkdirSync(join(withSubdir, 'nested'))
  try {
    assert.throws(() => readMentorPrompts(withSubdir), /directory/)
  } finally {
    rmSync(withSubdir, { recursive: true, force: true })
  }
  assert.throws(() => readMentorPrompts(join(tmpdir(), 'definitely-missing-prompts-dir')), /does not exist/)
})

test('generator: files that are not .md are ignored; only .md files become prompts', () => {
  const dir = tempDir({ 'one.md': 'prompt', '.gitkeep': '', 'README.txt': 'not a prompt', 'notes.md.bak': 'old' })
  try {
    assert.deepEqual(readMentorPrompts(dir).map((p) => p.id), ['one'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('generator CLI: write, --check passes, --check fails on drift or a missing file, usage error is 2, no prompt text is printed', () => {
  const dir = tempDir({ 'alpha.md': 'SECRET-ALPHA', 'beta.md': 'SECRET-BETA' })
  const out = join(tempDir(), 'mentorPromptsData.js')
  const logs = []
  const io = { log: (m) => logs.push(m), error: (m) => logs.push(m) }
  try {
    assert.equal(main({ args: ['--check'], promptsDir: dir, outputFile: out, ...io }), 1, 'a missing output file is drift')
    assert.equal(main({ args: [], promptsDir: dir, outputFile: out, ...io }), 0)
    assert.equal(main({ args: ['--check'], promptsDir: dir, outputFile: out, ...io }), 0)
    writeFileSync(join(dir, 'alpha.md'), 'SECRET-ALPHA changed')
    assert.equal(main({ args: ['--check'], promptsDir: dir, outputFile: out, ...io }), 1, 'a changed source is drift')
    assert.equal(main({ args: [], promptsDir: dir, outputFile: out, ...io }), 0)
    writeFileSync(out, `${readFileSync(out, 'utf8')}// hand edit\n`)
    assert.equal(main({ args: ['--check'], promptsDir: dir, outputFile: out, ...io }), 1, 'a hand-edited output is drift')
    writeFileSync(join(dir, 'gamma.md'), 'SECRET-GAMMA')
    assert.equal(main({ args: [], promptsDir: dir, outputFile: out, ...io }), 0)
    assert.match(readFileSync(out, 'utf8'), /"gamma"/, 'a new source file is picked up')
    assert.equal(main({ args: ['--bogus'], promptsDir: dir, outputFile: out, ...io }), 2)
    assert.equal(main({ args: [], promptsDir: join(dir, 'nope'), outputFile: out, ...io }), 1)
    assert.ok(!logs.join('\n').includes('SECRET'), 'no prompt text in any message')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dirname(out), { recursive: true, force: true })
  }
})

test('the build script and the generated module live where the design says, outside src/ and api/*.js', () => {
  assert.equal(OUTPUT_FILE, join(ROOT, 'api', '_lib', 'ai', 'mentorPromptsData.js'))
  assert.equal(PROMPTS_DIR, join(ROOT, 'mentor-prompts'))
})
