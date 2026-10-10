// Wire <-> database mapping for the signed-in user's own profile and settings (A3).
//
// The wire format is nested and camelCase (it mirrors the settings UI); the database is flat snake_case.
// Everything the API may read or write is listed here explicitly. Request bodies are never spread into a
// query: a writable column exists only if it appears in SETTINGS_FIELDS (or is profiles.display_name), which
// must stay equal to the column-level UPDATE grants in the migrations.
import { badRequest } from './errors.js'
import { parseDisplayName } from './validate.js'

export const THEMES = Object.freeze(['system', 'light', 'dark'])
export const RESPONSE_STYLES = Object.freeze(['concise', 'balanced', 'detailed'])

const bool = (value) => {
  if (typeof value !== 'boolean') throw badRequest()
  return value
}
const oneOf = (list) => (value) => {
  if (typeof value !== 'string' || !list.includes(value)) throw badRequest()
  return value
}

// section -> field -> { column, parse }
export const SETTINGS_FIELDS = Object.freeze({
  general: Object.freeze({
    theme: { column: 'theme', parse: oneOf(THEMES) },
  }),
  notifications: Object.freeze({
    email: { column: 'notifications_email', parse: bool },
    inApp: { column: 'notifications_in_app', parse: bool },
  }),
  privacy: Object.freeze({
    saveHistory: { column: 'save_history', parse: bool },
    rememberContext: { column: 'remember_context', parse: bool },
  }),
  ai: Object.freeze({
    responseStyle: { column: 'response_style', parse: oneOf(RESPONSE_STYLES) },
    useNameInResponses: { column: 'use_name_in_responses', parse: bool },
    suggestMentors: { column: 'suggest_mentors', parse: bool },
  }),
})

export const SETTINGS_BODY_KEYS = Object.freeze(Object.keys(SETTINGS_FIELDS))
export const PROFILE_BODY_KEYS = Object.freeze(['displayName'])

export const SETTINGS_TABLE = 'user_settings'
export const SETTINGS_OWNER_COLUMN = 'user_id'
export const PROFILE_TABLE = 'profiles'
export const PROFILE_OWNER_COLUMN = 'id'

export const SETTINGS_COLUMNS = Object.values(SETTINGS_FIELDS)
  .flatMap((section) => Object.values(section).map((field) => field.column))
  .join(',')
export const PROFILE_COLUMNS = 'display_name,created_at'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// { displayName } -> { display_name }. Exactly one writable profile column.
export function parseProfilePatch(body) {
  if (!isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, 'displayName')) throw badRequest()
  return { display_name: parseDisplayName(body.displayName) }
}

// Nested partial settings -> a flat { column: value } row containing only allowlisted columns.
// Unknown sections or fields, non-object sections, empty sections and empty patches are all rejected.
export function parseSettingsPatch(body) {
  if (!isPlainObject(body)) throw badRequest()
  const row = {}
  for (const section of Object.keys(body)) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_FIELDS, section)) throw badRequest()
    const values = body[section]
    if (!isPlainObject(values)) throw badRequest()
    const keys = Object.keys(values)
    if (keys.length === 0) throw badRequest()
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(SETTINGS_FIELDS[section], key)) throw badRequest()
      const { column, parse } = SETTINGS_FIELDS[section][key]
      row[column] = parse(values[key])
    }
  }
  if (Object.keys(row).length === 0) throw badRequest()
  return row
}

// Database row -> nested wire object. Only allowlisted columns are read.
export function rowToSettings(row) {
  const out = {}
  for (const [section, fields] of Object.entries(SETTINGS_FIELDS)) {
    out[section] = {}
    for (const [key, { column }] of Object.entries(fields)) out[section][key] = row[column]
  }
  return out
}

// email comes from the validated session user (read-only), never from the profiles table or the request.
export function rowToProfile(row, user) {
  return {
    displayName: typeof row.display_name === 'string' ? row.display_name : null,
    email: typeof user.email === 'string' ? user.email : null,
    createdAt: row.created_at,
  }
}
