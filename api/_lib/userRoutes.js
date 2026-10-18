// GET/PATCH /api/user/profile and /api/user/settings.
// Both run through the shared pipeline (method check, Origin + X-Ombre-Request on PATCH, JSON-only, 4 KiB
// limit, unknown top-level keys rejected, no-store, request ids, cookie propagation, generic errors).
import { createRoute } from './pipeline.js'
import { requireUser, oneRow } from './user.js'
import {
  PROFILE_TABLE,
  PROFILE_OWNER_COLUMN,
  PROFILE_COLUMNS,
  PROFILE_BODY_KEYS,
  SETTINGS_TABLE,
  SETTINGS_OWNER_COLUMN,
  SETTINGS_COLUMNS,
  SETTINGS_BODY_KEYS,
  parseProfilePatch,
  parseSettingsPatch,
  rowToProfile,
  rowToSettings,
} from './userData.js'

export function createUserRoutes({ getConfig, createSupabase, logger }) {
  const route = (options, fn) => createRoute({ getConfig, createSupabase, logger }, options, fn)

  const profile = route({ methods: ['GET', 'PATCH'], body: { PATCH: PROFILE_BODY_KEYS } }, async (ctx) => {
    const { supabase, user } = await requireUser(ctx)
    if (ctx.request.method === 'PATCH') {
      const row = parseProfilePatch(ctx.body) // explicit allowlist: only display_name can be written
      const result = await supabase.from(PROFILE_TABLE).update(row).eq(PROFILE_OWNER_COLUMN, user.id).select(PROFILE_COLUMNS)
      return { body: { profile: rowToProfile(oneRow(ctx, 'user.profile.update', result), user) } }
    }
    const result = await supabase.from(PROFILE_TABLE).select(PROFILE_COLUMNS).eq(PROFILE_OWNER_COLUMN, user.id)
    return { body: { profile: rowToProfile(oneRow(ctx, 'user.profile.read', result), user) } }
  })

  const settings = route({ methods: ['GET', 'PATCH'], body: { PATCH: SETTINGS_BODY_KEYS } }, async (ctx) => {
    const { supabase, user } = await requireUser(ctx)
    if (ctx.request.method === 'PATCH') {
      const row = parseSettingsPatch(ctx.body) // explicit allowlist: only grant-listed columns can be written
      const result = await supabase.from(SETTINGS_TABLE).update(row).eq(SETTINGS_OWNER_COLUMN, user.id).select(SETTINGS_COLUMNS)
      return { body: { settings: rowToSettings(oneRow(ctx, 'user.settings.update', result)) } }
    }
    const result = await supabase.from(SETTINGS_TABLE).select(SETTINGS_COLUMNS).eq(SETTINGS_OWNER_COLUMN, user.id)
    return { body: { settings: rowToSettings(oneRow(ctx, 'user.settings.read', result)) } }
  })

  return { profile, settings }
}
