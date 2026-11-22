#!/usr/bin/env node
// Generates api/_lib/ai/mentorPromptsData.js from mentor-prompts/*.md.
//
// Why a generated module: the .md files live outside api/, where Vercel's bundler would not reliably include them.
// A module that statically imports its data is traced into the function. The prompts are trusted server-side
// configuration and never reach the browser.
//
// Faithful by construction: each file is decoded as UTF-8 (strictly: invalid bytes are an error, never replaced)
// and embedded exactly. Nothing is trimmed, re-wrapped, re-encoded or normalized (line endings, a leading BOM and
// trailing newlines all survive). The output is deterministic: entries are sorted by mentor id.
//
//   node scripts/build-mentor-prompts.mjs            write api/_lib/ai/mentorPromptsData.js
//   node scripts/build-mentor-prompts.mjs --check    exit 1 if the committed file differs from the sources
//
// Messages name mentor ids only; prompt text is never printed.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const PROMPTS_DIR = join(ROOT, 'mentor-prompts')
export const OUTPUT_FILE = join(ROOT, 'api', '_lib', 'ai', 'mentorPromptsData.js')

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) // ignoreBOM: keep a BOM, do not strip it

// [{ id, text, sha256 }] sorted by id. Throws on anything that is not a clean, non-empty UTF-8 <slug>.md file.
export function readMentorPrompts(dir = PROMPTS_DIR) {
  if (!existsSync(dir)) throw new Error('The mentor prompts directory does not exist.')
  const prompts = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) throw new Error(`Unexpected directory in the mentor prompts directory: ${entry.name}`)
    if (!entry.name.endsWith('.md')) continue // not a prompt (for example a .gitkeep)
    const id = entry.name.slice(0, -'.md'.length)
    if (!ID_RE.test(id)) throw new Error(`Prompt file name is not a lowercase mentor id: ${entry.name}`)
    if (!entry.isFile()) throw new Error(`Prompt is not a regular file: ${entry.name}`)
    const bytes = readFileSync(join(dir, entry.name))
    let text
    try {
      text = DECODER.decode(bytes)
    } catch {
      throw new Error(`Prompt is not valid UTF-8: ${entry.name}`)
    }
    if (text.trim() === '') throw new Error(`Prompt is empty: ${entry.name}`)
    prompts.push({ id, text, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return prompts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function renderModule(prompts) {
  const body = (value) => prompts.map(({ id, ...rest }) => `  ${JSON.stringify(id)}: ${JSON.stringify(rest[value])},`).join('\n')
  return [
    '// GENERATED FILE - DO NOT EDIT BY HAND.',
    '// Source: mentor-prompts/<mentor-id>.md, one file per mentor, embedded exactly (decoded as UTF-8; nothing trimmed or',
    '// normalized). Regenerate with:  node scripts/build-mentor-prompts.mjs',
    '// Verify with:                   node scripts/build-mentor-prompts.mjs --check   (a test runs the same comparison)',
    '// Server-only trusted configuration: never imported by src/.',
    'export const MENTOR_PROMPTS = Object.freeze({',
    body('text'),
    '})',
    '',
    '// SHA-256 (hex) of each source file\'s bytes.',
    'export const MENTOR_PROMPT_SHA256 = Object.freeze({',
    body('sha256'),
    '})',
    '',
  ].join('\n')
}

export function buildMentorPromptsModule(dir = PROMPTS_DIR) {
  return renderModule(readMentorPrompts(dir))
}

// Returns the process exit code. Parameterised so tests can run it against temporary directories.
export function main({ args = [], promptsDir = PROMPTS_DIR, outputFile = OUTPUT_FILE, log = console.log, error = console.error } = {}) {
  const check = args.includes('--check')
  const unknown = args.filter((a) => a !== '--check')
  if (unknown.length > 0) {
    error('Usage: node scripts/build-mentor-prompts.mjs [--check]')
    return 2
  }
  let expected
  try {
    expected = buildMentorPromptsModule(promptsDir)
  } catch (e) {
    error(`Cannot build the mentor prompt module: ${e.message}`)
    return 1
  }
  if (check) {
    const actual = existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : null
    if (actual === expected) {
      log('Mentor prompt module is up to date.')
      return 0
    }
    error(actual === null ? 'Mentor prompt module is missing.' : 'Mentor prompt module is out of date with mentor-prompts/.')
    error('Run: node scripts/build-mentor-prompts.mjs')
    return 1
  }
  writeFileSync(outputFile, expected)
  log(`Wrote ${outputFile} (${readMentorPrompts(promptsDir).length} mentors).`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main({ args: process.argv.slice(2) })
}
