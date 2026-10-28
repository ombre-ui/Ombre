import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Guards for the schema-fingerprint tooling (docs/ops). They cannot run SQL (CI's Supabase job does that); they pin
// the properties that keep the fingerprint trustworthy: the CI-compared SQL and the recorded live baseline stay in
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
  assert.deepEqual([...sectionsOf(main)].sort(), [...expectedSections].sort())
  assert.equal(new Set(sectionsOf(main)).size, sectionsOf(main).length, 'no duplicated section')
})

// Update this snapshot ONLY in the change that applies new migrations to the live project, after regenerating the
// baseline from the live project (read-only). Until then the baseline is the live A3 schema and must not move.
test('the recorded baseline is pinned to the live A3 schema', () => {
  assert.equal(
    expected,
    [
      'colgrant|9|a280dae7774660fb0c42d9d1817b09ef',
      'column|15|7e1cffc8a367b5db666d41f2443bae19',
      'constraint|7|0f8767283ef6b4b55900b06559f8db4e',
      'defacl|12|24f0ab4b73a93cecacca8c2cb404b9f5',
      'funcexec|3|7e93315a8904997a0252487b9e78555b',
      'function|2|a527856f430336ca20d5488f2bbe7162',
      'policy|4|b1fa054e1a689fde25a62afe0bd0c1ef',
      'schema|1|2fb610e190853cdb9f39dbc371b201d3',
      'table|2|6a6cbb00aa56262b6c7c164385bce978',
      'tablegrant|18|14d8e8465526c1a505102d660229bb0c',
      'trigger|3|a8886213a0c656a1369ca652bcea023a',
      'TOTAL|76|73e929b300f36b06239fdd92e52ec207',
      '',
    ].join('\n'),
  )
})

test('the trigger section covers every public table (plus the signup trigger), not a hard-coded table list', () => {
  const section = triggerSection()
  assert.match(section, /relnamespace\s*=\s*'public'::regnamespace/)
  assert.match(section, /tgname\s*=\s*'on_auth_user_created'/)
  assert.equal(/'public\.[a-z_]+'::regclass/.test(section), false, 'tables must not be listed one by one')
  assert.match(section, /not\s+t\.tgisinternal/)
})

test('index and publication coverage is not wired into the CI-compared SQL before the baseline is regenerated', () => {
  assert.equal(sectionsOf(main).includes('index'), false)
  assert.equal(sectionsOf(main).includes('publication'), false)
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
