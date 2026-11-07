import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

// Static schema lint for the A4 migrations (it cannot run SQL): every foreign key on an A4 table must be backed by an
// index whose leading columns are the foreign key's columns. Without one, the referential action (cascade delete,
// ON DELETE SET NULL, or the check when a parent row is deleted) scans the whole referencing table.
//
// Postgres uses a btree for the equality lookups of those actions in two cases that this lint accepts:
//   1. the foreign key columns are the index's leading columns, in any order; or
//   2. the index leads with the foreign key's FIRST column. The composite foreign keys here are declared as
//      (entity id, user_id), so the leading entity id is selective and user_id is applied as a filter.
// An index leading only with a later column (for example user_id of a (conversation_id, user_id) key) does not qualify.
// A partial index qualifies only when its predicate is "<fk column> is not null", because the lookup is an equality
// on that column and NULLs never match a foreign key.

const dir = new URL('../../supabase/migrations/', import.meta.url)
const files = readdirSync(dir).filter((f) => /^2026102012\d{4}_a4_.*\.sql$/.test(f)).sort()
const sql = files.map((f) => readFileSync(new URL(f, dir), 'utf8').replace(/--[^\n]*/g, '')).join('\n')

const cols = (s) => s.split(',').map((c) => c.trim().split(/\s+/)[0].toLowerCase()).filter(Boolean)

function parseTables() {
  const tables = {}
  for (const m of sql.matchAll(/create table public\.(\w+) \(([\s\S]*?)\n\);/gi)) {
    const [, name, body] = m
    const items = []
    let depth = 0
    let cur = ''
    for (const ch of body) {
      if (ch === '(') depth += 1
      if (ch === ')') depth -= 1
      if (ch === ',' && depth === 0) {
        items.push(cur.trim())
        cur = ''
      } else cur += ch
    }
    items.push(cur.trim())
    const t = { fks: [], covers: [] } // covers: { columns, partialOn }
    for (const item of items) {
      let r
      if ((r = /foreign key\s*\(([^)]*)\)\s*references\s+([\w.]+)/i.exec(item))) t.fks.push({ columns: cols(r[1]), parent: r[2] })
      else if (/^constraint\s+\w+\s+(unique|primary key)/i.test(item) && (r = /\(([^)]*)\)/.exec(item))) t.covers.push({ columns: cols(r[1]) })
      else if (!/^constraint/i.test(item)) {
        const colName = item.split(/\s+/)[0].toLowerCase()
        if (/references\s+[\w.]+\s*\(/i.test(item)) t.fks.push({ columns: [colName], parent: /references\s+([\w.]+)/i.exec(item)[1] })
        if (/primary key/i.test(item)) t.covers.push({ columns: [colName] })
      }
    }
    tables[name] = t
  }
  for (const m of sql.matchAll(/create\s+(?:unique\s+)?index\s+(\w+)\s+on\s+public\.(\w+)\s*\(([^)]*)\)\s*(where\s+([^;]*))?;/gi)) {
    const [, indexName, table, columns, , predicate] = m
    const partialOn = predicate ? /^\s*(\w+)\s+is\s+not\s+null\s*$/i.exec(predicate)?.[1]?.toLowerCase() ?? '?' : null
    tables[table].covers.push({ columns: cols(columns), partialOn, indexName })
  }
  return tables
}

const tables = parseTables()

test('the A4 migration files are found and parsed', () => {
  assert.equal(files.length, 5)
  assert.deepEqual(Object.keys(tables).sort(), ['conversations', 'library_items', 'messages', 'projects', 'saved_items'])
})

test('every foreign key on an A4 table has a covering index (see the rule at the top of this file)', () => {
  const missing = []
  for (const [table, t] of Object.entries(tables)) {
    for (const fk of t.fks) {
      const want = [...fk.columns].sort().join(',')
      const covered = t.covers.some((c) => {
        const prefix = c.columns.slice(0, fk.columns.length)
        const fullPrefix = prefix.length === fk.columns.length && [...prefix].sort().join(',') === want
        if (!fullPrefix && c.columns[0] !== fk.columns[0]) return false
        if (c.partialOn === null || c.partialOn === undefined) return true
        return fk.columns.includes(c.partialOn) // "<fk column> is not null" partial indexes are fine
      })
      if (!covered) missing.push(`${table}(${fk.columns.join(', ')}) -> ${fk.parent}`)
    }
  }
  assert.deepEqual(missing, [], `foreign keys without a supporting index: ${missing.join('; ')}`)
})

test('the three indexes added for the review findings exist with the intended shape', () => {
  const find = (table, name) => tables[table].covers.find((c) => c.indexName === name)
  assert.deepEqual(find('saved_items', 'saved_items_message_idx'), { columns: ['message_id', 'conversation_id'], partialOn: 'message_id', indexName: 'saved_items_message_idx' })
  assert.deepEqual(find('library_items', 'library_items_project_idx'), { columns: ['project_id'], partialOn: 'project_id', indexName: 'library_items_project_idx' })
  // messages: the idempotency index is unique, non-partial and leads with user_id (serves the auth.users cascade)
  assert.deepEqual(find('messages', 'messages_user_request_key'), { columns: ['user_id', 'client_request_id'], partialOn: null, indexName: 'messages_user_request_key' })
  assert.match(sql, /create unique index messages_user_request_key\s+on public\.messages \(user_id, client_request_id\);/)
})

test('no redundant indexes: no two indexes or constraints on a table share the same column list', () => {
  for (const [table, t] of Object.entries(tables)) {
    const seen = new Map()
    for (const c of t.covers) {
      const key = `${c.columns.join(',')}|${c.partialOn ?? ''}`
      assert.equal(seen.has(key), false, `${table}: duplicate coverage on (${c.columns.join(', ')})`)
      seen.set(key, true)
    }
  }
})
