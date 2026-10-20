import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MENTOR_CATALOG, MENTOR_IDS, isMentorId } from '../../src/features/mentors/catalogData.js'

// The catalog is the source of truth for mentor ids in A4 (no mentors table). These tests pin the shape the
// database and the API rely on: ids are unique, match the conversations.mentor_id check, and the data module
// stays free of React/icon imports so api/ can import it.

const EXPECTED_IDS = [
  'startup-validator',
  'business-model-mentor',
  'marketing-strategist',
  'team-hiring-advisor',
  'engineering-architect',
  'flow-weaver',
  'bug-hunter',
  'systems-engineer',
  'attention-optimizer',
  'planning-architect',
  'execution-auditor',
  'momentum-specialist',
  'cadence-architect',
  'movement-builder',
  'rhythm-architect',
  'regen-optimizer',
]

test('the catalog still holds exactly the 16 mentors, in order', () => {
  const ids = MENTOR_CATALOG.flatMap((c) => c.subcategories.flatMap((s) => s.mentors.map((m) => m.id)))
  assert.deepEqual(ids, EXPECTED_IDS)
  assert.deepEqual(
    MENTOR_CATALOG.map((c) => c.id),
    ['business', 'coding', 'productivity', 'health'],
  )
  assert.equal(MENTOR_IDS.size, 16)
})

test('mentor ids match the database shape check and are unique', () => {
  for (const id of EXPECTED_IDS) {
    assert.ok(id.length <= 64, id)
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  }
  assert.equal(new Set(EXPECTED_IDS).size, EXPECTED_IDS.length)
})

test('isMentorId accepts only catalog ids', () => {
  for (const id of EXPECTED_IDS) assert.equal(isMentorId(id), true)
  for (const bad of ['', 'Startup-Validator', 'unknown-mentor', 'business', ' bug-hunter', null, undefined, 5, {}, ['bug-hunter']]) {
    assert.equal(isMentorId(bad), false, String(bad))
  }
  assert.equal(isMentorId('__proto__'), false)
  assert.equal(isMentorId('constructor'), false)
})

test('catalogData.js has no import statements, so it is safe to load server-side', () => {
  const source = readFileSync(new URL('../../src/features/mentors/catalogData.js', import.meta.url), 'utf8')
  assert.equal(/^\s*import\s/m.test(source), false)
  assert.equal(/lucide|react/i.test(source.replace(/\/\/.*$/gm, '')), false)
})

test('categories.js builds the UI catalog from catalogData.js and only adds icons', () => {
  const source = readFileSync(new URL('../../src/features/mentors/categories.js', import.meta.url), 'utf8')
  assert.match(source, /from '\.\/catalogData\.js'/)
  assert.match(source, /lucide-react/)
  assert.equal(/description:\s*'/.test(source), false, 'descriptions must live only in catalogData.js')
})
