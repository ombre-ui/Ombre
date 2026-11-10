import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Guards for the schema-fingerprint tooling (docs/ops). They cannot run SQL (CI's Supabase job does that); they pin
// the properties that keep the fingerprint trustworthy: the CI-compared SQL and the recorded live A4 baseline stay in
// step, the baseline is not edited by accident, and every SQL file is read-only and deterministic.

const read = (p) => readFileSync(new URL(`../../docs/ops/${p}`, import.meta.url), 'utf8')
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '')

const main = read('schema-fingerprint.sql')
const coverage = read('schema-fingerprint-coverage.sql')
const expected = read('schema-fingerprint.expected')

const sectionsOf = (sql) => [...stripComments(sql).matchAll(/select\s+'([a-z]+)'/g)].map((m) => m[1])
const triggerSection = () => {
  const code = stripComments(main)
  const start = code.indexOf("select 'trigger'")
  return code.slice(start, code.indexOf('union all', start))
}

test('the CI-compared SQL produces exactly the sections of the recorded baseline', () => {
  const expectedSections = expected.trim().split('\n').map((l) => l.split('|')[0]).filter((s) => s !== 'TOTAL')
  const mainSections = sectionsOf(main)
  assert.deepEqual(mainSections.filter((s) => s !== 'publication').sort(), [...expectedSections].sort())
  assert.ok(mainSections.includes('publication'), 'publication coverage must be wired into the CI SQL')
  assert.equal(new Set(mainSections).size, mainSections.length, 'no duplicated section')
})

// Update this snapshot ONLY in the change that applies new migrations to the live project, after regenerating the
// baseline from the live project (read-only). Until then the baseline is the live A4 schema and must not move.
test('the recorded baseline is pinned to the live A4 schema', () => {
  assert.equal(
    expected,
    [
      'colgrant|26|54baad1fc7ca2d87d2d6f466e147c0ad',
      'column|53|1a70438de267d26781899d16808012f3',
      'constraint|40|d18320fa1c5556b4bbefc7b8d0d99679',
      'defacl|12|24f0ab4b73a93cecacca8c2cb404b9f5',
      'funcexec|8|ca01daa4a24808e9c53165d8d2196ae2',
      'function|6|e33a67acfd2c8ad3b4513575f029e2f3',
      'index|20|e7db24af223e131e36372136aa7db828',
      'policy|18|d726c2ca15dd866ff783404f9406e239',
      'schema|1|2fb610e190853cdb9f39dbc371b201d3',
      'table|7|1b46179c63ffea71c82adfa2f63cb0d2',
      'tablegrant|26|17c3845fad893d9925754981e0452c3b',
      'trigger|10|9581e3ba325a16232d94f8465c0a903d',
      'TOTAL|227|71af22d9e66b0237b0a544bd87107366',
    ].join('\n') + '\n',
  )
})

test('the trigger section covers every public table (plus the signup trigger), not a hard-coded table list', () => {
  const section = triggerSection()
  assert.match(section, /relnamespace\s*=\s*'public'::regnamespace/)
  assert.match(section, /tgname\s*=\s*'on_auth_user_created'/)
  assert.equal(/'public\.[a-z_]+'::regclass/.test(section), false, 'tables must not be listed one by one')
  assert.match(section, /not\s+t\.tgisinternal/)
})

test('index and publication coverage is wired into the CI-compared SQL', () => {
  assert.equal(sectionsOf(main).includes('index'), true)
  assert.equal(sectionsOf(main).includes('publication'), true)
  assert.deepEqual(sectionsOf(coverage), ['index', 'publication'])
})

test('the coverage SQL reads indexes and Realtime publications of the public schema only', () => {
  const code = stripComments(coverage)
  assert.match(code, /from\s+pg_indexes\s+i\s+where\s+i\.schemaname\s*=\s*'public'/)
  assert.match(code, /from\s+pg_publication_tables\s+pt\s+where\s+pt\.schemaname\s*=\s*'public'/)
  assert.match(code, /i\.indexdef/)
})

for (const [name, sql] of [['schema-fingerprint.sql', main], ['schema-fingerprint-coverage.sql', coverage]]) {
  test(`${name} is read-only`, () => {
    const code = stripComments(sql)
    assert.match(code.trim(), /^with\s+r\s+as\s*\(/i, 'a single WITH ... SELECT statement')
    assert.equal(/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|copy|call|do)\b/i.test(code.replace(/'[^']*'/g, "''")), false)
    assert.equal((code.match(/;/g) || []).length, 1, 'exactly one statement')
  })

  test(`${name} is deterministic: sorted with collate "C", no volatile values`, () => {
    const code = stripComments(sql)
    assert.match(code, /string_agg\(line,\s*E'\\n'\s+order by line collate "C"\)/)
    assert.match(code, /order by sec nulls last/)
    for (const volatile of [/\bnow\s*\(/i, /current_timestamp/i, /clock_timestamp/i, /\brandom\s*\(/i, /txid_current/i, /pg_stat_/i, /pg_backend_pid/i, /::oid\b/i, /\boid::text/i, /gen_random_uuid/i]) {
      assert.equal(volatile.test(code), false, String(volatile))
    }
  })
}
