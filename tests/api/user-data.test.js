import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDisplayName, DISPLAY_NAME_MAX_LENGTH } from '../../api/_lib/validate.js'
import { SETTINGS_FIELDS, SETTINGS_COLUMNS, PROFILE_COLUMNS, parseSettingsPatch, rowToSettings, rowToProfile } from '../../api/_lib/userData.js'

// Column-level UPDATE grants from supabase/migrations (phase_1b_settings_foundation). If a migration changes
// them, update this list and userData.js together.
const GRANTED_SETTINGS_COLUMNS = [
  'theme', 'remember_context', 'notifications_email', 'notifications_in_app',
  'save_history', 'response_style', 'use_name_in_responses', 'suggest_mentors',
]

test('writable settings columns equal the migration grant list exactly', () => {
  const writable = Object.values(SETTINGS_FIELDS).flatMap((s) => Object.values(s).map((f) => f.column))
  assert.deepEqual([...writable].sort(), [...GRANTED_SETTINGS_COLUMNS].sort())
  assert.deepEqual(SETTINGS_COLUMNS.split(',').sort(), [...GRANTED_SETTINGS_COLUMNS].sort())
  for (const forbidden of ['user_id', 'created_at', 'updated_at', 'id']) assert.ok(!writable.includes(forbidden))
})

test('profile selects only display_name and created_at', () => {
  assert.equal(PROFILE_COLUMNS, 'display_name,created_at')
})

test('parseDisplayName', () => {
  assert.equal(parseDisplayName('  Ada  '), 'Ada')
  assert.equal(parseDisplayName(''), null)
  assert.equal(parseDisplayName('   \u00a0 '), null)
  assert.equal(parseDisplayName(null), null)
  assert.equal(parseDisplayName('e\u0301'), '\u00e9') // NFC
  assert.equal(parseDisplayName('x'.repeat(DISPLAY_NAME_MAX_LENGTH)).length, DISPLAY_NAME_MAX_LENGTH)
  for (const bad of [undefined, 5, true, {}, [], 'x'.repeat(DISPLAY_NAME_MAX_LENGTH + 1), 'a\nb', 'a\rb', 'a\u2028b', 'a\u0085b', 'a\u007fb']) {
    assert.throws(() => parseDisplayName(bad), (e) => e.status === 400, String(bad))
  }
})

test('parseSettingsPatch returns a fresh flat row of allowlisted columns', () => {
  const row = parseSettingsPatch({ ai: { responseStyle: 'detailed' }, general: { theme: 'light' } })
  assert.deepEqual(row, { response_style: 'detailed', theme: 'light' })
})

test('rowToSettings reads only allowlisted columns and ignores extras', () => {
  const settings = rowToSettings({ ...Object.fromEntries(GRANTED_SETTINGS_COLUMNS.map((c) => [c, c.startsWith('theme') ? 'dark' : true])), user_id: 'x', secret: 'y' })
  assert.deepEqual(Object.keys(settings).sort(), ['ai', 'general', 'notifications', 'privacy'])
  assert.ok(!JSON.stringify(settings).includes('"x"') && !JSON.stringify(settings).includes('"y"'))
})

test('rowToProfile: email comes from the session user only', () => {
  assert.deepEqual(rowToProfile({ display_name: null, created_at: 't', email: 'evil@example.com' }, { email: 'a@b.co' }), { displayName: null, email: 'a@b.co', createdAt: 't' })
  assert.equal(rowToProfile({ display_name: 'n', created_at: 't' }, {}).email, null)
})
