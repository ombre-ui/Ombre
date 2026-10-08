import { ApiError, badRequest, unauthorized, tooManyRequests, unavailable, isRetryable, isRateLimited, isSessionMissing, isVerifierMissing } from './errors.js'
import { createRoute } from './pipeline.js'
import { parseEmail, parseExistingPassword, parseNewPassword, parseAuthCode, parseFlowId, parsePurpose } from './validate.js'

const NEXT_AFTER_SIGN_IN = '/app/general'
const NEXT_AFTER_RECOVERY = '/reset-password'

function publicUser(user) {
  return { id: user.id, email: user.email ?? null }
}

// Never let a provider outage look like "wrong password" or "signed out".
function throwIfTransient(error) {
  if (isRetryable(error)) throw unavailable()
  if (isRateLimited(error)) throw tooManyRequests()
}

export function createRoutes({ getConfig, createSupabase, logger }) {
  const route = (options, fn) => createRoute({ getConfig, createSupabase, logger }, options, fn)

  // GET /api/auth/session: authorization uses getUser() (validated by the Auth server), never getSession().
  const session = route({ methods: ['GET'] }, async (ctx) => {
    const { supabase, jar } = ctx.supa()
    const { data, error } = await supabase.auth.getUser()
    if (error) {
      if (isRetryable(error)) throw unavailable()
      if (!isSessionMissing(error)) {
        ctx.logAuthError('auth.session.invalid', error)
        jar.expireAllAuthCookies()
      }
      return { body: { user: null } }
    }
    if (!data || !data.user) return { body: { user: null } }
    return { body: { user: publicUser(data.user) } }
  })

  const signin = route({ methods: ['POST'], body: ['email', 'password'] }, async (ctx) => {
    const email = parseEmail(ctx.body.email)
    const password = parseExistingPassword(ctx.body.password)
    const { supabase } = ctx.supa()
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      ctx.logAuthError('auth.signin.failed', error)
      throwIfTransient(error)
      // email_not_confirmed is only returned after the password verified, so it reveals nothing to a stranger.
      if (error.code === 'email_not_confirmed') throw new ApiError(403, 'email_not_confirmed')
      throw unauthorized('invalid_credentials')
    }
    if (!data || !data.user) throw unauthorized('invalid_credentials')
    return { body: { ok: true, user: publicUser(data.user) } }
  })

  // POST /api/auth/signup: identical response whether or not the address already has an account.
  const signup = route({ methods: ['POST'], body: ['email', 'password'] }, async (ctx) => {
    const email = parseEmail(ctx.body.email)
    const password = parseNewPassword(ctx.body.password)
    const { supabase } = ctx.supa()
    const emailRedirectTo = `${ctx.origin}/auth/callback`
    const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo } })
    if (error) {
      ctx.logAuthError('auth.signup.failed', error)
      throwIfTransient(error)
      if (error.code === 'weak_password') throw badRequest('weak_password')
      if (error.code === 'user_already_exists') return { body: { ok: true, status: 'check_email' } }
      throw badRequest('signup_failed')
    }
    if (data && data.session) ctx.log('auth.signup.session_returned', {}) // email confirmation appears to be disabled
    return { body: { ok: true, status: 'check_email' } }
  })

  const forgotPassword = route({ methods: ['POST'], body: ['email'] }, async (ctx) => {
    const email = parseEmail(ctx.body.email)
    const { supabase } = ctx.supa()
    const redirectTo = `${ctx.origin}/auth/callback/recovery`
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) {
      ctx.logAuthError('auth.forgot.failed', error)
      throwIfTransient(error)
      // Any other error is swallowed so the response never reveals whether the address exists.
    }
    return { body: { ok: true } }
  })

  // POST /api/auth/callback: PKCE code exchange for email confirmation and password recovery.
  const callback = route({ methods: ['POST'], body: ['code', 'flowId', 'purpose'] }, async (ctx) => {
    const code = parseAuthCode(ctx.body.code)
    const flowId = parseFlowId(ctx.body.flowId)
    const purpose = parsePurpose(ctx.body.purpose)
    const { supabase } = ctx.supa()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined)
    if (error) {
      ctx.logAuthError('auth.callback.failed', error)
      if (isRetryable(error)) throw unavailable()
      if (isVerifierMissing(error)) throw badRequest('link_wrong_browser')
      throw badRequest('link_invalid_or_expired')
    }
    const user = (data && (data.user || (data.session && data.session.user))) || null
    if (!user) throw badRequest('link_invalid_or_expired')
    const recovery = purpose === 'recovery' || (data && data.redirectType === 'PASSWORD_RECOVERY')
    return { body: { ok: true, next: recovery ? NEXT_AFTER_RECOVERY : NEXT_AFTER_SIGN_IN, user: publicUser(user) } }
  })

  const resetPassword = route({ methods: ['POST'], body: ['password'] }, async (ctx) => {
    const password = parseNewPassword(ctx.body.password)
    const { supabase } = ctx.supa()
    const current = await supabase.auth.getUser()
    if (current.error || !current.data || !current.data.user) {
      if (isRetryable(current.error)) throw unavailable()
      throw unauthorized()
    }
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      ctx.logAuthError('auth.reset.failed', error)
      throwIfTransient(error)
      if (error.code === 'same_password') throw badRequest('same_password')
      if (error.code === 'weak_password') throw badRequest('weak_password')
      if (error.code === 'reauthentication_needed') throw new ApiError(403, 'recent_login_required')
      throw badRequest('reset_failed')
    }
    return { body: { ok: true } }
  })

  const signout = route({ methods: ['POST'], body: null }, async (ctx) => {
    const { supabase, jar } = ctx.supa()
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch (error) {
      ctx.logAuthError('auth.signout.error', error)
    }
    jar.expireAllAuthCookies() // belt and braces: session chunks, verifier slots, stale chunks
    return { body: { ok: true } }
  })

  return { session, signin, signup, forgotPassword, callback, resetPassword, signout }
}
